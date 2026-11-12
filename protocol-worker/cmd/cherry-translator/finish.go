package main

import (
	"bytes"
	"encoding/json"
	t "github.com/router-for-me/CLIProxyAPI/v8/sdk/translator"
	"strings"
)

// Some adapters prefer a tool-call stop or emit a completed envelope even
// when native upstream explicitly reports truncation. Preserve that reason.
func finishReason(data []byte) string {
	data = bytes.TrimSpace(data)
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte("data:")))
	var v map[string]any
	if json.Unmarshal(data, &v) != nil {
		return ""
	}
	classify := func(value any) string {
		switch value {
		case "length", "max_tokens", "MAX_TOKENS", "max_output_tokens":
			return "limit"
		case "content_filter", "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "refusal":
			return "blocked"
		}
		return ""
	}
	for _, key := range []string{"choices", "candidates"} {
		if choices, ok := v[key].([]any); ok {
			for _, raw := range choices {
				if choice, ok := raw.(map[string]any); ok {
					for _, field := range []string{"finish_reason", "finishReason"} {
						if reason := classify(choice[field]); reason != "" {
							return reason
						}
					}
				}
			}
		}
	}
	if reason := classify(v["stop_reason"]); reason != "" {
		return reason
	}
	if delta, ok := v["delta"].(map[string]any); ok {
		if reason := classify(delta["stop_reason"]); reason != "" {
			return reason
		}
	}
	if response, ok := v["response"].(map[string]any); ok {
		v = response
	}
	if details, ok := v["incomplete_details"].(map[string]any); ok {
		return classify(details["reason"])
	}
	return ""
}
func preserveFinish(data []byte, format t.Format, reason string) []byte {
	if reason == "" {
		return data
	}
	patch := func(raw []byte) []byte {
		var v map[string]any
		if json.Unmarshal(raw, &v) != nil {
			return raw
		}
		switch format {
		case t.FormatOpenAI:
			if choices, ok := v["choices"].([]any); ok {
				for _, raw := range choices {
					if choice, ok := raw.(map[string]any); ok && choice["finish_reason"] != nil {
						if reason == "limit" {
							choice["finish_reason"] = "length"
						} else {
							choice["finish_reason"] = "content_filter"
						}
					}
				}
			}
		case t.FormatClaude:
			dest := v
			if delta, ok := v["delta"].(map[string]any); ok {
				dest = delta
			}
			if dest["stop_reason"] != nil {
				if reason == "limit" {
					dest["stop_reason"] = "max_tokens"
				} else {
					dest["stop_reason"] = "refusal"
				}
			}
		case t.FormatGemini:
			if candidates, ok := v["candidates"].([]any); ok {
				for _, raw := range candidates {
					if c, ok := raw.(map[string]any); ok && c["finishReason"] != nil {
						if reason == "limit" {
							c["finishReason"] = "MAX_TOKENS"
						} else {
							c["finishReason"] = "SAFETY"
						}
					}
				}
			}
		case t.FormatOpenAIResponse:
			dest := v
			if response, ok := v["response"].(map[string]any); ok {
				dest = response
			}
			if dest["object"] == "response" || dest["status"] == "completed" || dest["status"] == "incomplete" {
				dest["status"] = "incomplete"
				why := "content_filter"
				if reason == "limit" {
					why = "max_output_tokens"
				}
				dest["incomplete_details"] = map[string]any{"reason": why}
			}
			if v["type"] == "response.completed" {
				v["type"] = "response.incomplete"
			}
		}
		result, err := json.Marshal(v)
		if err != nil {
			return raw
		}
		return result
	}
	if json.Valid(data) {
		return patch(data)
	}
	lines := strings.Split(string(data), "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "data:") {
			lines[i] = "data: " + string(patch([]byte(strings.TrimSpace(line[5:]))))
		}
		if line == "event: response.completed" && format == t.FormatOpenAIResponse {
			lines[i] = "event: response.incomplete"
		}
	}
	return []byte(strings.Join(lines, "\n"))
}
