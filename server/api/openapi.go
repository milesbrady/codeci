package api

import "fmt"

// openAPISpec returns a static OpenAPI 3.0 spec describing the /api/v1
// surface. Built as a Go string literal (not parsed at startup) so the
// server doesn't need to read any files at runtime.
func openAPISpec(version string) []byte {
	return []byte(fmt.Sprintf(openAPITemplate, version))
}

const openAPITemplate = `{
  "openapi": "3.0.3",
  "info": {
    "title": "Codeci API",
    "description": "Programmatic access for CI systems and LLM agents. Authenticate with an API key (Authorization: Bearer idk_...) minted in the Settings UI. Workflow: list pipelines → fetch pipeline schema → trigger run → poll run status → fetch logs.",
    "version": "%s"
  },
  "servers": [
    { "url": "/api/v1", "description": "current host" }
  ],
  "components": {
    "securitySchemes": {
      "apiKey": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "idk_<hex>",
        "description": "Long-lived API key minted in Settings → API Keys. Inherits the issuing user's role."
      }
    },
    "schemas": {
      "Health": {
        "type": "object",
        "properties": {
          "status":  {"type": "string", "example": "ok"},
          "version": {"type": "string"},
          "time":    {"type": "string", "format": "date-time"}
        }
      },
      "Me": {
        "type": "object",
        "properties": {
          "user_id":  {"type": "integer"},
          "username": {"type": "string"},
          "is_admin": {"type": "boolean"}
        }
      },
      "PipelineSummary": {
        "type": "object",
        "properties": {
          "id":          {"type": "string"},
          "name":        {"type": "string"},
          "description": {"type": "string"},
          "version":     {"type": "string"},
          "param_count": {"type": "integer"}
        }
      },
      "Parameter": {
        "type": "object",
        "properties": {
          "id":          {"type": "string"},
          "label":       {"type": "string"},
          "type":        {"type": "string", "enum": ["text", "select", "checkbox", "password"]},
          "required":    {"type": "boolean"},
          "default":     {"type": "string", "nullable": true},
          "placeholder": {"type": "string"},
          "options":     {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {"type": "string"},
                "value": {"type": "string"}
              }
            }
          },
          "source": {"type": "string", "description": "Optional; e.g. git-branches:<param_id> for dynamic options"}
        }
      },
      "Pipeline": {
        "type": "object",
        "properties": {
          "id":          {"type": "string"},
          "name":        {"type": "string"},
          "description": {"type": "string"},
          "version":     {"type": "string"},
          "parameters":  {"type": "array", "items": {"$ref": "#/components/schemas/Parameter"}},
          "step_count":  {"type": "integer"}
        }
      },
      "RunRequest": {
        "type": "object",
        "properties": {
          "params": {
            "type": "object",
            "additionalProperties": {"type": "string"},
            "description": "Map of parameter id to value. All values are strings; checkbox params accept 'true'/'false'."
          }
        }
      },
      "Run": {
        "type": "object",
        "properties": {
          "run_id":         {"type": "integer"},
          "pipeline_id":    {"type": "string"},
          "pipeline_name":  {"type": "string"},
          "status":         {"type": "string", "enum": ["running", "success", "failed", "cancelled", "timed_out"]},
          "started_at":     {"type": "string", "format": "date-time"},
          "finished_at":    {"type": "string", "format": "date-time", "nullable": true},
          "duration_ms":    {"type": "integer"},
          "exit_code":      {"type": "integer", "nullable": true},
          "failed_step":    {"type": "string"},
          "failure_reason": {"type": "string"},
          "logs_url":       {"type": "string"},
          "status_url":     {"type": "string"},
          "cancel_url":     {"type": "string"}
        }
      },
      "RunList": {
        "type": "object",
        "properties": {
          "runs":  {"type": "array", "items": {"$ref": "#/components/schemas/Run"}},
          "total": {"type": "integer"},
          "page":  {"type": "integer"},
          "limit": {"type": "integer"},
          "pages": {"type": "integer"}
        }
      },
      "LogMessage": {
        "type": "object",
        "properties": {
          "type":  {"type": "string", "enum": ["init", "step", "stdout", "stderr", "exit", "error", "meta"]},
          "data":  {"type": "string"},
          "code":  {"type": "integer", "nullable": true},
          "step":  {"type": "string"},
          "seq":   {"type": "integer"},
          "time":  {"type": "integer", "description": "Server clock in unix millis"}
        }
      },
      "LogsResponse": {
        "type": "object",
        "properties": {
          "run_id":     {"type": "integer"},
          "status":     {"type": "string"},
          "messages":   {"type": "array", "items": {"$ref": "#/components/schemas/LogMessage"}},
          "next_since": {"type": "integer", "description": "Pass as ?since_seq= on the next poll for incremental fetch"}
        }
      },
      "Error": {
        "type": "object",
        "properties": {
          "message": {"type": "string"}
        }
      }
    }
  },
  "security": [{"apiKey": []}],
  "paths": {
    "/health": {
      "get": {
        "summary": "Health probe",
        "security": [],
        "responses": {
          "200": {"description": "OK", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Health"}}}}
        }
      }
    },
    "/openapi.json": {
      "get": {
        "summary": "This OpenAPI document",
        "security": [],
        "responses": {"200": {"description": "OpenAPI 3.0 JSON"}}
      }
    },
    "/me": {
      "get": {
        "summary": "Identify the calling key",
        "responses": {
          "200": {"description": "Caller info", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Me"}}}},
          "401": {"description": "Unauthorized"}
        }
      }
    },
    "/pipelines": {
      "get": {
        "summary": "List pipelines",
        "responses": {
          "200": {
            "description": "Pipelines",
            "content": {"application/json": {"schema": {
              "type": "object",
              "properties": {"pipelines": {"type": "array", "items": {"$ref": "#/components/schemas/PipelineSummary"}}}
            }}}
          }
        }
      }
    },
    "/pipelines/{id}": {
      "get": {
        "summary": "Get a pipeline's full parameter schema",
        "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
        "responses": {
          "200": {"description": "Pipeline", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pipeline"}}}},
          "404": {"description": "Not found"}
        }
      }
    },
    "/pipelines/{id}/runs": {
      "post": {
        "summary": "Trigger a pipeline run",
        "parameters": [
          {"name": "id", "in": "path", "required": true, "schema": {"type": "string"}},
          {"name": "wait", "in": "query", "schema": {"type": "boolean"}, "description": "If true, block until completion or timeout"},
          {"name": "timeout_seconds", "in": "query", "schema": {"type": "integer", "default": 300, "maximum": 3600}, "description": "Used only when wait=true"}
        ],
        "requestBody": {
          "required": true,
          "content": {"application/json": {"schema": {"$ref": "#/components/schemas/RunRequest"}}}
        },
        "responses": {
          "202": {"description": "Run started", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Run"}}}},
          "400": {"description": "Invalid params"},
          "404": {"description": "Pipeline not found"}
        }
      }
    },
    "/runs": {
      "get": {
        "summary": "List runs",
        "parameters": [
          {"name": "page", "in": "query", "schema": {"type": "integer", "default": 1}},
          {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 50, "maximum": 200}},
          {"name": "status", "in": "query", "schema": {"type": "string"}},
          {"name": "pipeline_id", "in": "query", "schema": {"type": "string"}}
        ],
        "responses": {
          "200": {"description": "Paginated runs", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/RunList"}}}}
        }
      }
    },
    "/runs/{id}": {
      "get": {
        "summary": "Get run status",
        "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "integer"}}],
        "responses": {
          "200": {"description": "Run", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Run"}}}},
          "404": {"description": "Not found"}
        }
      }
    },
    "/runs/{id}/logs": {
      "get": {
        "summary": "Get run logs",
        "parameters": [
          {"name": "id", "in": "path", "required": true, "schema": {"type": "integer"}},
          {"name": "format", "in": "query", "schema": {"type": "string", "enum": ["json", "text"], "default": "json"}},
          {"name": "since_seq", "in": "query", "schema": {"type": "integer"}, "description": "Return only messages with seq > since_seq (JSON mode)"},
          {"name": "tail", "in": "query", "schema": {"type": "integer"}, "description": "Return only the last N lines (text mode)"},
          {"name": "include_stdout", "in": "query", "schema": {"type": "boolean", "default": true}, "description": "If false, omits stdout lines from the text-mode response"}
        ],
        "responses": {
          "200": {
            "description": "Logs",
            "content": {
              "application/json": {"schema": {"$ref": "#/components/schemas/LogsResponse"}},
              "text/plain": {"schema": {"type": "string"}}
            }
          },
          "404": {"description": "Not found"}
        }
      }
    },
    "/runs/{id}/cancel": {
      "post": {
        "summary": "Cancel a running run",
        "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "integer"}}],
        "responses": {
          "200": {"description": "Cancellation requested"},
          "400": {"description": "Run is not active"},
          "404": {"description": "Run not found"}
        }
      }
    },
    "/scripts": {
      "get": {
        "summary": "List user scripts",
        "responses": {"200": {"description": "Scripts"}}
      }
    }
  }
}`
