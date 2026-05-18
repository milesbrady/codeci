import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/themes/prism-tomorrow.css';
import { Button } from '@/components/ui/button';
import { Save, X } from 'lucide-react';

const EditorComponent = (Editor as any).default || Editor;

interface ShellEditorProps {
  value: string;
  onChange: (val: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  title?: string;
}

export function ShellEditor({ value, onChange, onSave, onCancel, saving, title }: ShellEditorProps) {
  return (
    <div className="flex flex-col h-full bg-zinc-900/40 rounded-xl border border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">{title ?? "Edit Shell Script"}</h2>
          <p className="text-xs text-zinc-500">Write your shell script using bash syntax</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            <X className="h-4 w-4 mr-1.5" />
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} loading={saving}>
            <Save className="h-4 w-4 mr-1.5" />
            Save Script
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 custom-scrollbar-shell">
        <div className="min-h-full bg-zinc-950 rounded-lg border border-zinc-800">
          <EditorComponent
            value={value}
            onValueChange={onChange}
            highlight={(code: string) => Prism.highlight(code, Prism.languages.bash, 'bash')}
            padding={20}
            className="font-mono text-sm shell-editor-container"
            style={{
              fontFamily: '"Fira code", "Fira Mono", monospace',
              minHeight: '100%',
              outline: 'none',
            }}
          />
        </div>
      </div>

      <style>{`
        .shell-editor-container textarea {
          outline: none !important;
          caret-color: #a78bfa;
        }
        .custom-scrollbar-shell::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar-shell::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar-shell::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 4px;
        }
        .custom-scrollbar-shell::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
}
