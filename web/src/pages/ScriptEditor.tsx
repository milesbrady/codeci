import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { scriptsApi } from "@/lib/api";
import { Layout, PageHeader } from "@/components/Layout";
import { ShellEditor } from "@/components/ShellEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft } from "lucide-react";

const DEFAULT_SCRIPT = `#!/bin/bash
set -e

# Your script here
echo "Hello from user script"
`;

export function ScriptCreate() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [content, setContent] = useState(DEFAULT_SCRIPT);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) {
      alert("Please enter a script name");
      return;
    }
    setSaving(true);
    try {
      await scriptsApi.create(name.trim(), content);
      navigate("/scripts");
    } catch (err: any) {
      alert(err.response?.data?.message || "Failed to create script");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title="Create New Script"
        description="Write a reusable shell script"
        action={
          <Button variant="ghost" size="sm" onClick={() => navigate("/scripts")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        }
      />

      <div className="flex flex-col gap-4 p-8 h-[calc(100vh-85px)]">
        <div className="flex flex-col gap-1.5 max-w-md">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Script Name
          </label>
          <Input
            placeholder="e.g. deploy-staging"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-zinc-900/60 border-zinc-800"
          />
        </div>

        <div className="flex-1 min-h-0">
          <ShellEditor
            value={content}
            onChange={setContent}
            onSave={handleSave}
            onCancel={() => navigate("/scripts")}
            saving={saving}
            title="New Shell Script"
          />
        </div>
      </div>
    </Layout>
  );
}

export function ScriptEdit() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    scriptsApi.get(id)
      .then((res) => {
        setContent(res.data.content);
        setName(res.data.name);
      })
      .catch(() => alert("Failed to load script"))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleSave() {
    if (!id) return;
    setSaving(true);
    try {
      await scriptsApi.update(id, content);
      navigate("/scripts");
    } catch (err: any) {
      alert(err.response?.data?.message || "Failed to save script");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-full text-zinc-500">Loading…</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader
        title={`Edit: ${name}`}
        description="Modify the shell script content"
        action={
          <Button variant="ghost" size="sm" onClick={() => navigate("/scripts")}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        }
      />

      <div className="p-8 h-[calc(100vh-85px)]">
        <ShellEditor
          value={content}
          onChange={setContent}
          onSave={handleSave}
          onCancel={() => navigate("/scripts")}
          saving={saving}
          title={name}
        />
      </div>
    </Layout>
  );
}
