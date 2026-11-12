// Cherry owns network transport and secrets. This process only translates bytes.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/claude/gemini"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/claude/openai/chat-completions"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/claude/openai/responses"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/codex/claude"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/codex/gemini"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/codex/openai/chat-completions"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/gemini/claude"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/gemini/openai/chat-completions"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/gemini/openai/responses"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/openai/claude"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/openai/gemini"
	_ "github.com/router-for-me/CLIProxyAPI/v8/internal/translator/openai/openai/responses"
	t "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"github.com/sirupsen/logrus"
	"os"
	"time"
)

const version = "cherry-translator-1"
const maxPayload = 25 * 1024 * 1024

type message struct {
	V       int    `json:"v"`
	ID      string `json:"id"`
	Seq     int    `json:"seq"`
	Op      string `json:"op"`
	From    string `json:"from"`
	To      string `json:"to"`
	Model   string `json:"model"`
	Stream  bool   `json:"stream"`
	Payload string `json:"payload"`
}
type reply struct {
	V        int      `json:"v"`
	ID       string   `json:"id"`
	Seq      int      `json:"seq"`
	Payloads []string `json:"payloads,omitempty"`
	Error    string   `json:"error,omitempty"`
	Version  string   `json:"version,omitempty"`
}
type session struct {
	original, request []byte
	from, to          t.Format
	model             string
	state             any
	touched, started  time.Time
	retained          int
	finish            string
}

// Serialized retained-byte budgets also bound adapters which accumulate text
// or tool fragments internally. No session can grow indefinitely while its
// consumer is slow; Node admits eight sessions under the same total budget.
func retainedBytes(sessions map[string]*session) int {
	total := 0
	for _, s := range sessions {
		total += len(s.original) + len(s.request) + s.retained
	}
	return total
}

func source(v string) t.Format {
	switch v {
	case "chat":
		return t.FormatOpenAI
	case "responses":
		return t.FormatOpenAIResponse
	case "messages":
		return t.FormatClaude
	case "gemini":
		return t.FormatGemini
	}
	return ""
}
func target(v string) t.Format {
	if v == "responses" {
		return t.FormatCodex
	}
	return source(v)
}

// Upstream's Gemini adapter consumes Anthropic event transcripts for its
// non-stream entrypoint. Adapt the native JSON envelope without losing blocks.
func nativeAnthropicEvents(data []byte) []byte {
	var message map[string]any
	if json.Unmarshal(data, &message) != nil {
		return data
	}
	var out bytes.Buffer
	emit := func(value any) {
		b, _ := json.Marshal(value)
		out.WriteString("data: ")
		out.Write(b)
		out.WriteString("\n\n")
	}
	blocks, _ := message["content"].([]any)
	header := map[string]any{}
	for k, v := range message {
		header[k] = v
	}
	header["content"] = []any{}
	emit(map[string]any{"type": "message_start", "message": header})
	for i, raw := range blocks {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		start := map[string]any{}
		for k, v := range block {
			start[k] = v
		}
		var delta map[string]any
		switch block["type"] {
		case "text":
			start["text"] = ""
			delta = map[string]any{"type": "text_delta", "text": block["text"]}
		case "thinking":
			start["thinking"] = ""
			delta = map[string]any{"type": "thinking_delta", "thinking": block["thinking"]}
		case "tool_use":
			start["input"] = map[string]any{}
			args, _ := json.Marshal(block["input"])
			delta = map[string]any{"type": "input_json_delta", "partial_json": string(args)}
		}
		emit(map[string]any{"type": "content_block_start", "index": i, "content_block": start})
		if delta != nil {
			emit(map[string]any{"type": "content_block_delta", "index": i, "delta": delta})
		}
		emit(map[string]any{"type": "content_block_stop", "index": i})
	}
	emit(map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": message["stop_reason"], "stop_sequence": message["stop_sequence"]}, "usage": message["usage"]})
	emit(map[string]any{"type": "message_stop"})
	return out.Bytes()
}
func handle(m message, sessions map[string]*session) (r reply) {
	r = reply{V: 1, ID: m.ID, Seq: m.Seq}
	defer func() {
		if recover() != nil {
			delete(sessions, m.ID)
			r.Payloads = nil
			r.Error = "translation_failed"
		}
	}()
	if m.V != 1 || m.ID == "" || len(m.ID) > 100 || m.Seq < 0 {
		r.Error = "invalid_worker_message"
		return
	}
	if m.Op == "hello" {
		r.Version = version
		return
	}
	if m.Op == "cancel" || m.Op == "end" {
		delete(sessions, m.ID)
		return
	}
	data, err := base64.StdEncoding.Strict().DecodeString(m.Payload)
	if err != nil || len(data) > maxPayload {
		r.Error = "invalid_worker_payload"
		return
	}
	if m.Op == "request" {
		if sessions[m.ID] != nil {
			r.Error = "duplicate_request_id"
			return
		}
		if len(sessions) >= 8 {
			r.Error = "translator_busy"
			return
		}
		from, to := source(m.From), target(m.To)
		registry := t.Default()
		if from == "" || to == "" || !registry.HasRequestTransformer(from, to) || !registry.HasStreamResponseTransformer(from, to) || !registry.HasNonStreamResponseTransformer(from, to) {
			r.Error = "unsupported_protocol_pair"
			return
		}
		if !json.Valid(data) {
			r.Error = "invalid_json"
			return
		}
		// Gemini selects streaming in the URL, whereas several shared adapters
		// inspect the original body's stream flag when translating responses.
		var original map[string]any
		if json.Unmarshal(data, &original) != nil || original == nil {
			r.Error = "invalid_json"
			return
		}
		original["stream"] = m.Stream
		data, _ = json.Marshal(original)
		req := registry.TranslateRequestEnvelope(context.Background(), from, to, t.RequestEnvelope{Format: from, Model: m.Model, Stream: m.Stream, Body: data})
		if req.Err != nil || !json.Valid(req.Body) {
			r.Error = "unsupported_protocol_feature"
			return
		}
		// No vendor login/session optimizers: the generic Responses API accepts non-streaming.
		if m.To == "responses" {
			var body map[string]any
			_ = json.Unmarshal(req.Body, &body)
			body["stream"] = m.Stream
			req.Body, _ = json.Marshal(body)
		}
		if len(req.Body) > maxPayload || retainedBytes(sessions)+len(data)+len(req.Body)+8*1024*1024 > 128*1024*1024 {
			r.Error = "translator_memory_limit"
			return
		}
		sessions[m.ID] = &session{original: data, request: req.Body, from: from, to: to, model: m.Model, touched: time.Now(), started: time.Now()}
		r.Payloads = []string{base64.StdEncoding.EncodeToString(req.Body)}
		return
	}
	s := sessions[m.ID]
	if s == nil {
		r.Error = "unknown_request_id"
		return
	}
	s.touched = time.Now()
	if retainedBytes(sessions)+len(data) > 128*1024*1024 {
		delete(sessions, m.ID)
		r.Error = "translator_memory_limit"
		return
	}
	var chunks [][]byte
	switch m.Op {
	case "response":
		if !json.Valid(data) {
			r.Error = "invalid_upstream_response"
			return
		}
		if s.to == t.FormatClaude && s.from == t.FormatGemini {
			s.finish = finishReason(data)
			data = nativeAnthropicEvents(data)
		}
		if s.finish == "" {
			s.finish = finishReason(data)
		}
		if s.to == t.FormatCodex {
			var body map[string]any
			_ = json.Unmarshal(data, &body)
			if body["type"] == nil {
				data, _ = json.Marshal(map[string]any{"type": "response.completed", "response": body})
			}
		}
		chunks = [][]byte{t.TranslateNonStream(context.Background(), s.to, s.from, s.model, s.original, s.request, data, &s.state)}
		delete(sessions, m.ID)
	case "chunk":
		if len(data) > 1024*1024 {
			r.Error = "stream_event_too_large"
			return
		}
		s.retained += len(data)
		if s.retained > 8*1024*1024 {
			delete(sessions, m.ID)
			r.Error = "stream_buffer_limit"
			return
		}
		chunks = t.TranslateStream(context.Background(), s.to, s.from, s.model, s.original, s.request, data, &s.state)
		if reason := finishReason(data); reason != "" {
			s.finish = reason
		}
	default:
		r.Error = "invalid_worker_operation"
		return
	}
	for _, chunk := range chunks {
		chunk = preserveFinish(chunk, s.from, s.finish)
		if len(chunk) > maxPayload {
			delete(sessions, m.ID)
			r.Payloads = nil
			r.Error = "translator_output_limit"
			return
		}
		if len(chunk) == 0 {
			continue
		}
		if m.Op == "response" && s.from == t.FormatOpenAIResponse {
			var envelope map[string]json.RawMessage
			if json.Unmarshal(chunk, &envelope) == nil && envelope["response"] != nil {
				chunk = envelope["response"]
			}
		}
		r.Payloads = append(r.Payloads, base64.StdEncoding.EncodeToString(chunk))
	}
	if m.Op == "response" && len(r.Payloads) == 0 {
		r.Error = "translation_empty_response"
	}
	return
}
func main() {
	logrus.SetOutput(os.Stderr)
	logrus.SetLevel(logrus.PanicLevel)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 36*1024*1024)
	out := bufio.NewWriter(os.Stdout)
	sessions := map[string]*session{}
	for scanner.Scan() {
		now := time.Now()
		for id, s := range sessions {
			if now.Sub(s.touched) > 120*time.Second || now.Sub(s.started) > 15*time.Minute {
				delete(sessions, id)
			}
		}
		var m message
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			os.Exit(2)
		}
		r := handle(m, sessions)
		data, err := json.Marshal(r)
		if err != nil {
			os.Exit(2)
		}
		fmt.Fprintln(out, string(data))
		if out.Flush() != nil {
			return
		}
	}
	if scanner.Err() != nil {
		os.Exit(2)
	}
}
