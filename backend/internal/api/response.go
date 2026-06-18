package api

import (
	"encoding/json"
	"net/http"
)

// envelope is the standard JSON response wrapper for all API responses.
// Every response carries either Data or Error, never both.
type envelope struct {
	Data  any            `json:"data,omitempty"`
	Error string         `json:"error,omitempty"`
	Meta  map[string]any `json:"meta,omitempty"`
}

// JSON marshals v into JSON and writes it to w with the given HTTP status code.
// It sets Content-Type to application/json before writing.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(v); err != nil {
		// At this point the header is already sent, so we can only log.
		// The caller should ensure v is always serialisable.
		_ = err
	}
}

// JSONError writes an error envelope with the given HTTP status and human-friendly message.
// Use plain, friendly language for message — no stack traces, no technical jargon.
func JSONError(w http.ResponseWriter, status int, message string) {
	JSON(w, status, envelope{Error: message})
}

// JSONData writes a data envelope with the given HTTP status and payload.
func JSONData(w http.ResponseWriter, status int, data any) {
	JSON(w, status, envelope{Data: data})
}
