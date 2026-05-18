import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { ModeToggle } from "@/pages/PipelineCreate";
import { Button } from "@/components/ui/button";
import { ArrowLeft, HelpCircle, Trash2 } from "lucide-react";
import { PipelineHelp } from "@/components/PipelineHelp";

type Mode = "builder" | "yaml";

export function PipelineEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("builder");
  const [showHelp, setShowHelp] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [builder, setBuilder] = useState<BuilderState>(blankBuilderState());
  const [yamlError, setYamlError] = useState("");

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    pipelinesApi
      .getRaw(id)
      .then((res) => {
        if (cancelled) return;
        const text = res.data.raw;
        setYamlText(text);
        setBuilder(yamlToBuilder(text));
        setLoadError("");
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError("Failed to load pipeline.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Reflect builder edits in the YAML buffer so the toggle is cheap.
  useEffect(() => {
    if (mode === "builder") setYamlText(builderToYaml(builder));
  }, [builder, mode]);

  const filenameHint = useMemo(() => `${id ?? ""}.yaml`, [id]);

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
    if (!id) return;
    const text = mode === "builder" ? builderToYaml(builder) : yamlText;
    setSaving(true);
    try {
      await pipelinesApi.update(id, text);
      navigate(`/pipelines/${id}`);
    } catch (err: any) {
      alert(err?.response?.data?.message || "Failed to save pipeline");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!confirm("Delete this pipeline? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await pipelinesApi.delete(id);
      navigate("/pipelines");
    } catch (err: any) {
      alert(err?.response?.data?.message || "Failed to delete pipeline");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <Layout>
        <PageHeader title="Edit Pipeline" />
        <div className="p-8 space-y-3">
          <div className="h-8 rounded bg-zinc-900 animate-pulse" />
          <div className="h-64 rounded bg-zinc-900 animate-pulse" />
        </div>
      </Layout>
    );
  }

  if (loadError) {
    return (
      <Layout>
        <PageHeader title="Edit Pipeline" />
        <div className="p-8">
          <div className="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {loadError}
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title={`Edit: ${builder.name || id}`}
        description={
          mode === "builder"
            ? "Edit visually — toggle to YAML any time."
            : "Edit raw YAML — toggle to the visual builder any time."
        }
        action={
          <div className="flex items-center gap-2">
            <ModeToggle mode={mode} onSwitch={(m) => (m === "yaml" ? switchToYaml() : switchToBuilder())} />
            <Button variant="ghost" size="sm" onClick={() => setShowHelp(!showHelp)}>
              <HelpCircle className="h-4 w-4 mr-1.5" />
              Help
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-red-400 hover:text-red-300 hover:bg-red-400/10"
              onClick={handleDelete}
              disabled={deleting}
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate(id ? `/pipelines/${id}` : "/pipelines")}>
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
              saveLabel="Save changes"
              filenameHint={filenameHint}
              collapseExisting
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
                  onCancel={() => navigate(id ? `/pipelines/${id}` : "/pipelines")}
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
