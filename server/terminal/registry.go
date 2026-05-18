package terminal

import (
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
)

// Session is one user's live terminal: a local PTY master FD bound to a
// `docker exec -it` process attached to the user's ephemeral runner container.
// LastActivity is updated on every client input and consulted by the idle
// watchdog. cancel() tears the whole session down (kills exec, stops container,
// removes from registry, closes the WS).
type Session struct {
	UserID        uint
	ContainerName string
	PTY           *os.File
	Cmd           *exec.Cmd
	LastActivity  atomic.Int64 // unix nanos
	cancel        func()
	closeOnce     sync.Once
}

// Close runs the registered teardown exactly once. Safe to call from any
// goroutine that observes a terminal condition (PTY EOF, WS read error,
// idle timeout, container died).
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		if s.cancel != nil {
			s.cancel()
		}
	})
}

// Registry enforces the single-session-per-user rule. Keyed by UserID, so a
// second connection from the same user (any tab, any browser) collides with
// the first and is rejected — never joined or replaced.
type Registry struct {
	mu       sync.Mutex
	sessions map[uint]*Session
}

func NewRegistry() *Registry {
	return &Registry{sessions: map[uint]*Session{}}
}

// TryClaim atomically reserves a slot for userID. If one is already taken,
// returns (existing, false) so the caller can refuse the connection.
func (r *Registry) TryClaim(userID uint, s *Session) (*Session, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.sessions[userID]; ok {
		return existing, false
	}
	r.sessions[userID] = s
	return s, true
}

func (r *Registry) Get(userID uint) *Session {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessions[userID]
}

// Remove drops the slot only if the stored session is the one passed in.
// Guards against a race where TryClaim has already given the slot to a new
// session by the time the old session's teardown reaches Remove.
func (r *Registry) Remove(userID uint, s *Session) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions[userID] == s {
		delete(r.sessions, userID)
	}
}

func (r *Registry) Has(userID uint) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.sessions[userID]
	return ok
}
