package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"

	"github.com/codeci/codeci/server/auth"
)

// idleTimeout is the inactivity threshold (no client input) after which the
// session is killed. 30 minutes matches the user-confirmed scope; tunable via
// TERMINAL_IDLE_TIMEOUT_MINUTES env if we ever need to.
const idleTimeout = 30 * time.Minute

var upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	CheckOrigin:      func(r *http.Request) bool { return true },
}

// connMutexes is a per-connection write mutex pool. gorilla/websocket isn't
// safe for concurrent writes; we may have the PTY-reader goroutine and the
// control-message sender both writing at once.
var connMutexes sync.Map // *websocket.Conn -> *sync.Mutex

func wsWriteText(conn *websocket.Conn, payload any) error {
	mu, _ := connMutexes.LoadOrStore(conn, new(sync.Mutex))
	m := mu.(*sync.Mutex)
	m.Lock()
	defer m.Unlock()
	b, _ := json.Marshal(payload)
	return conn.WriteMessage(websocket.TextMessage, b)
}

func wsWriteBinary(conn *websocket.Conn, data []byte) error {
	mu, _ := connMutexes.LoadOrStore(conn, new(sync.Mutex))
	m := mu.(*sync.Mutex)
	m.Lock()
	defer m.Unlock()
	return conn.WriteMessage(websocket.BinaryMessage, data)
}

type Handler struct {
	jwtSecret    string
	registry     *Registry
	storageRoot  string // absolute path; root contains users/<id> and shared/
}

func NewHandler(jwtSecret string, registry *Registry, storageRoot string) *Handler {
	abs, err := filepath.Abs(storageRoot)
	if err != nil {
		abs = storageRoot
	}
	return &Handler{jwtSecret: jwtSecret, registry: registry, storageRoot: abs}
}

// Status — GET /api/terminal/status. Lets the UI pre-flight whether the user
// already has a session before attempting the WS upgrade.
func (h *Handler) Status(c echo.Context) error {
	claims := auth.GetClaims(c)
	if claims == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "no claims in context")
	}
	return c.JSON(http.StatusOK, map[string]bool{"active": h.registry.Has(claims.UserID)})
}

type clientMsg struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// Attach — GET /ws/terminal?token=<jwt>. Auths via query param (matches the
// existing /ws/execute pattern), enforces single-session, spins up the
// runner, and streams a PTY both ways.
func (h *Handler) Attach(c echo.Context) error {
	token := c.QueryParam("token")
	if token == "" {
		return echo.NewHTTPError(http.StatusUnauthorized, "missing token")
	}
	claims, err := auth.ParseJWT(token, h.jwtSecret)
	if err != nil || !claims.TOTPPassed {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid or incomplete auth")
	}
	userID := claims.UserID

	conn, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	defer connMutexes.Delete(conn)

	// Single-session-per-user gate. Reserve the slot with a placeholder; if
	// container start fails later we'll Remove ourselves before returning.
	placeholder := &Session{UserID: userID}
	if _, claimed := h.registry.TryClaim(userID, placeholder); !claimed {
		_ = wsWriteText(conn, map[string]any{
			"type": "error",
			"data": "You already have a terminal session open. Close it before opening a new one.",
		})
		return nil
	}

	userDir := filepath.Join(h.storageRoot, "users", itoa(userID))
	sharedDir := filepath.Join(h.storageRoot, "shared")

	startCtx, startCancel := context.WithTimeout(context.Background(), 30*time.Second)
	containerName, err := StartContainer(startCtx, userID, userDir, sharedDir)
	startCancel()
	if err != nil {
		log.Printf("[terminal] start container for user %d: %v", userID, err)
		_ = wsWriteText(conn, map[string]any{"type": "error", "data": "failed to start terminal container"})
		h.registry.Remove(userID, placeholder)
		return nil
	}

	// Allocate a local PTY whose far end docker-exec inherits. The `-it` flags
	// make docker request a TTY in the container — bash sees a real TTY and
	// gives the user a normal interactive prompt.
	cmd := exec.Command("docker", "exec", "-it", containerName, "bash")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Printf("[terminal] pty.Start for user %d: %v", userID, err)
		_ = wsWriteText(conn, map[string]any{"type": "error", "data": "failed to attach PTY"})
		StopContainer(containerName)
		h.registry.Remove(userID, placeholder)
		return nil
	}

	sessionCtx, sessionCancel := context.WithCancel(context.Background())
	session := &Session{
		UserID:        userID,
		ContainerName: containerName,
		PTY:           ptmx,
		Cmd:           cmd,
		cancel:        sessionCancel,
	}
	session.LastActivity.Store(time.Now().UnixNano())
	// Swap the placeholder for the real session. Safe: TryClaim above guaranteed
	// nobody else can have raced in.
	h.registry.Remove(userID, placeholder)
	h.registry.TryClaim(userID, session)

	// Single teardown path — every goroutine exits via `defer cleanup()` so it
	// runs exactly once regardless of which condition fires first.
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			session.Close()
			_ = ptmx.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			StopContainer(containerName)
			h.registry.Remove(userID, session)
			_ = conn.Close()
		})
	}
	defer cleanup()

	_ = wsWriteText(conn, map[string]any{
		"type":      "ready",
		"container": containerName,
	})

	// PTY → WS (binary frames; raw PTY bytes preserve UTF-8 / ANSI exactly).
	go func() {
		defer cleanup()
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				if werr := wsWriteBinary(conn, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					log.Printf("[terminal] pty read user=%d: %v", userID, err)
				}
				return
			}
		}
	}()

	// Idle watchdog: kill the session if no input arrives for `idleTimeout`.
	// Output activity (e.g. tail -f) does NOT reset the timer — "idle" means
	// the user themselves has walked away.
	go func() {
		defer cleanup()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				last := time.Unix(0, session.LastActivity.Load())
				if time.Since(last) >= idleTimeout {
					_ = wsWriteText(conn, map[string]any{"type": "timeout"})
					return
				}
			case <-sessionCtx.Done():
				return
			}
		}
	}()

	// WS → PTY (text frames carrying JSON: input keystrokes + resize events).
	// This goroutine OWNS the read side of the WS, so it's the natural place
	// to detect client disconnect.
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return nil
		}
		if mt != websocket.TextMessage {
			continue
		}
		var m clientMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "input":
			session.LastActivity.Store(time.Now().UnixNano())
			if _, err := ptmx.Write([]byte(m.Data)); err != nil {
				return nil
			}
		case "resize":
			if m.Cols > 0 && m.Rows > 0 {
				_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(m.Cols), Rows: uint16(m.Rows)})
			}
		}
	}
}

func itoa(u uint) string {
	if u == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for u > 0 {
		i--
		buf[i] = byte('0' + u%10)
		u /= 10
	}
	return string(buf[i:])
}
