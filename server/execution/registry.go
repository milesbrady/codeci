package execution

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// MaxMessagesInMemory caps the per-run in-memory log backlog. When more
// messages are emitted, the oldest are dropped (FIFO). On snapshot we prepend
// a synthetic stdout line summarizing how many were dropped so the client
// can show a "[truncated N earlier lines]" notice.
const MaxMessagesInMemory = 10_000

type ActiveRun struct {
	PipelineID  string
	mu          sync.RWMutex
	ring        []WSMessage // fixed-cap ring; nil until first append
	head        int         // next write index in ring
	full        bool        // true once ring has wrapped at least once
	dropped     int         // total messages evicted from the ring
	seq         atomic.Int64
	Subscribers map[*websocket.Conn]bool
	Done        chan struct{}
	cancel      func() // call to forcibly stop the run's context
}

type RunRegistry struct {
	mu   sync.RWMutex
	runs map[uint]*ActiveRun
}

func NewRegistry() *RunRegistry {
	return &RunRegistry{
		runs: make(map[uint]*ActiveRun),
	}
}

func (r *RunRegistry) GetOrCreate(runID uint, pipelineID string) (*ActiveRun, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if run, ok := r.runs[runID]; ok {
		return run, false
	}

	run := &ActiveRun{
		PipelineID:  pipelineID,
		Subscribers: make(map[*websocket.Conn]bool),
		Done:        make(chan struct{}),
		cancel:      func() {}, // replaced by ws_handler after context creation
	}
	r.runs[runID] = run
	return run, true
}

func (r *RunRegistry) Get(runID uint) (*ActiveRun, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	run, ok := r.runs[runID]
	return run, ok
}

func (r *RunRegistry) List() []*ActiveRun {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*ActiveRun, 0, len(r.runs))
	for _, run := range r.runs {
		list = append(list, run)
	}
	return list
}

func (r *RunRegistry) Remove(runID uint) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.runs, runID)
}

// SetCancel stores the context cancel function for this run.
func (ar *ActiveRun) SetCancel(fn func()) {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	ar.cancel = fn
}

// Cancel stops the run by invoking its context cancel function.
func (ar *ActiveRun) Cancel() {
	ar.mu.RLock()
	fn := ar.cancel
	ar.mu.RUnlock()
	if fn != nil {
		fn()
	}
}

// nextSeq returns a monotonic per-run sequence number. Used as a stable
// React key on the frontend so virtualization keeps row identity correct.
func (ar *ActiveRun) nextSeq() int64 {
	return ar.seq.Add(1)
}

// appendMessage stores msg in the bounded ring buffer. Caller must hold ar.mu.
func (ar *ActiveRun) appendMessage(msg WSMessage) {
	if ar.ring == nil {
		ar.ring = make([]WSMessage, MaxMessagesInMemory)
	}
	if ar.full {
		ar.dropped++
	}
	ar.ring[ar.head] = msg
	ar.head++
	if ar.head == MaxMessagesInMemory {
		ar.head = 0
		ar.full = true
	}
}

// GetMessages returns a flat snapshot copy of the in-memory log backlog,
// preserving order from oldest to newest. If any messages have been dropped
// from the ring, a synthetic stdout marker is prepended so clients can show
// the user a truncation notice.
func (ar *ActiveRun) GetMessages() []WSMessage {
	ar.mu.RLock()
	defer ar.mu.RUnlock()
	return ar.snapshotLocked()
}

func (ar *ActiveRun) snapshotLocked() []WSMessage {
	var msgs []WSMessage
	if ar.full {
		msgs = make([]WSMessage, 0, MaxMessagesInMemory+1)
	} else {
		msgs = make([]WSMessage, 0, ar.head+1)
	}
	if ar.dropped > 0 {
		msgs = append(msgs, WSMessage{
			Type: MsgStdout,
			Data: fmt.Sprintf("[truncated %d earlier log lines to keep memory bounded]\n", ar.dropped),
		})
	}
	if ar.full {
		msgs = append(msgs, ar.ring[ar.head:]...)
		msgs = append(msgs, ar.ring[:ar.head]...)
	} else {
		msgs = append(msgs, ar.ring[:ar.head]...)
	}
	return msgs
}

func (ar *ActiveRun) Subscribe(conn *websocket.Conn, sendBacklog bool) {
	ar.mu.Lock()
	var backlog []WSMessage
	if sendBacklog {
		backlog = ar.snapshotLocked()
	}
	ar.Subscribers[conn] = true
	ar.mu.Unlock()

	for _, msg := range backlog {
		_ = wsSend(conn, msg)
	}
}

func (ar *ActiveRun) Unsubscribe(conn *websocket.Conn) {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	delete(ar.Subscribers, conn)
}

func (ar *ActiveRun) Broadcast(msg WSMessage) {
	if msg.Seq == 0 {
		msg.Seq = ar.nextSeq()
	}
	if msg.Time == 0 {
		msg.Time = time.Now().UnixMilli()
	}
	ar.mu.Lock()
	if !msg.Transient {
		ar.appendMessage(msg)
	}
	conns := make([]*websocket.Conn, 0, len(ar.Subscribers))
	for conn := range ar.Subscribers {
		conns = append(conns, conn)
	}
	ar.mu.Unlock()

	for _, conn := range conns {
		_ = wsSend(conn, msg)
	}
}
