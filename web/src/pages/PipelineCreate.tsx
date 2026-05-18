import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { pipelinesApi } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { YamlEditor } from "@/components/YamlEditor";
import {
  PipelineBuilder,
  blankBuilderState,
  builderToYaml,
  yamlToBuilder,
  type BuilderState,
} from "@/components/PipelineBuilder";
import { Button } from "@/components/ui/button";
import { ArrowLeft, HelpCircle, Code2, Wand2 } from "lucide-react";
import { PipelineHelp } from "@/components/PipelineHelp";
import { cn } from "@/lib/utils";

type Mode = "builder" | "yaml";

const STARTER_TEMPLATE: BuilderState = {
  ...blankBuilderState(),
  name: "",
  description: "",
  version: "1.0",
};

function slugifyForFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}.yaml` : "unnamed.yaml";
}

export function PipelineCreate() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("builder");
  const [showHelp, setShowHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [builder, setBuilder] = useState<BuilderState>(STARTER_TEMPLATE);
  const [yamlText, setYamlText] = useState<string>(builderToYaml(STARTER_TEMPLATE));
  const [yamlError, setYamlError] = useState<string>("");

  // Keep YAML in sync whenever Builder state changes (Builder is source of truth in builder mode).
  useEffect(() => {
    if (mode === "builder") setYamlText(builderToYaml(builder));
  }, [builder, mode]);

  const filenameHint = useMemo(() => slugifyForFilename(builder.name), [builder.name]);

  function switchToYaml() {
    setYamlText(builderToYaml(builder));
    setYamlError("");
    setMode("yaml");
  }

  function switchToBuilder() {
    try {
      const parsed = yamlToBuilder(yamlText);
      setBuilder(parsed);
      setYamlError("");
      setMode("builder");
    } catch (e: any) {
      setYamlError(`Cannot switch to builder — YAML is not valid: ${e?.message ?? e}`);
    }
  }

  async function handleSave() {
    const text = mode === "builder" ? builderToYaml(builder) : yamlText;
    const name = mode === "builder" ? builder.name : (yamlToBuilder(text).name || "");
    if (!name.trim()) {
      alert("Please give the pipeline a name.");
      return;
    }
    setSaving(true);
    try {
      await pipelinesApi.create(name, text);
      navigate("/pipelines");
    } catch (err: any) {
      alert(err?.response?.data?.message || "Failed to create pipeline");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title="Create New Pipeline"
        description={
          mode === "builder"
            ? "Build it visually — toggle to YAML any time."
            : "Edit raw YAML — toggle to the visual builder any time."
        }
        action={
          <div className="flex items-center gap-2">
            <ModeToggle mode={mode} onSwitch={(m) => (m === "yaml" ? switchToYaml() : switchToBuilder())} />
            <Button variant="ghost" size="sm" onClick={() => setShowHelp(!showHelp)}>
              <HelpCircle className="h-4 w-4 mr-1.5" />
              Help
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/pipelines")}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </div>
        }
      />

      <div className="flex flex-col md:flex-row gap-4 md:gap-6 px-4 md:px-8 pb-8 pt-4 md:h-[calc(100vh-85px)] min-h-0">
        <div className="flex-1 min-w-0">
          {mode === "builder" ? (
            <PipelineBuilder
              state={builder}
              onChange={setBuilder}
              onSave={handleSave}
              saving={saving}
              saveLabel="Create pipeline"
              showTemplates
              filenameHint={filenameHint}
            />
          ) : (
            <div className="md:h-full flex flex-col gap-2 min-h-[60vh]">
              {yamlError && (
                <div className="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                  {yamlError}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <YamlEditor
                  value={yamlText}
                  onChange={(v) => {
                    setYamlText(v);
                    setYamlError("");
                  }}
                  onSave={handleSave}
                  onCancel={() => navigate("/pipelines")}
                  saving={saving}
                />
              </div>
            </div>
          )}
        </div>

        {showHelp && (
          <div className="w-full md:w-96 md:flex-shrink-0 md:overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 animate-in slide-in-from-right-5 duration-300">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-zinc-300">Pipeline Schema Help</h2>
              <Button variant="ghost" size="sm" onClick={() => setShowHelp(false)} className="h-7 w-7 p-0">
                ×
              </Button>
            </div>
            <PipelineHelp />
          </div>
        )}
      </div>
    </Layout>
  );
}

export function ModeToggle({ mode, onSwitch }: { mode: Mode; onSwitch: (m: Mode) => void }) {
  return (
    <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
      <button
        type="button"
        onClick={() => onSwitch("builder")}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors",
          mode === "builder"
            ? "bg-violet-600 text-white"
            : "text-zinc-400 hover:text-zinc-100",
        )}
      >
        <Wand2 className="h-3.5 w-3.5" />
        Builder
      </button>
      <button
        type="button"
        onClick={() => onSwitch("yaml")}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors",
          mode === "yaml"
            ? "bg-violet-600 text-white"
            : "text-zinc-400 hover:text-zinc-100",
        )}
      >
        <Code2 className="h-3.5 w-3.5" />
        YAML
      </button>
    </div>
  );
}
