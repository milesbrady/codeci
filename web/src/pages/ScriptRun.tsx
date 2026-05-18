import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { scriptsApi } from "@/lib/api";
import { createScriptSocket } from "@/lib/ws";
import type { WsMessage } from "@/lib/ws";
import { Layout, PageHeader } from "@/components/Layout";
import { LogTerminal } from "@/components/LogTerminal";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RotateCw } from "lucide-react";

export function ScriptRun() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [scriptName, setScriptName] = useState("");
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [running, setRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  function startRun() {
    if (!id) return;
    setMessages([]);
    setRunning(true);

    const ws = createScriptSocket(
      id,
      (msg) => setMessages((prev) => [...prev, msg]),
      () => setRunning(false),
    );
    wsRef.current = ws;
  }

  useEffect(() => {
    if (!id) return;
    scriptsApi.get(id)
      .then((res) => setScriptName(res.data.name))
      .catch(() => {});
    startRun();

    return () => {
      wsRef.current?.close();
    };
  }, [id]);

  return (
    <Layout>
      <PageHeader
        title={scriptName ? `Run: ${scriptName}` : "Run Script"}
        description="Live execution output"
        action={
          <div className="flex items-center gap-2">
            {!running && (
              <Button size="sm" variant="outline" onClick={startRun} className="gap-1.5">
                <RotateCw className="h-4 w-4" />
                Run Again
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => navigate("/scripts")}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </div>
        }
      />

      <div className="p-8 h-[calc(100vh-85px)]">
        <LogTerminal messages={messages} running={running} />
      </div>
    </Layout>
  );
}
