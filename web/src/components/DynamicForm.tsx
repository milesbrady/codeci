import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { gitApi, type PipelineOption, type PipelineParameter } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";

interface DynamicFormProps {
  parameters: PipelineParameter[];
  onSubmit: (values: Record<string, string>) => void;
  loading?: boolean;
  // Customizes the submit button. Used by the trigger-defaults page to
  // render "Save defaults" instead of the run icon + "Run Pipeline".
  submitLabel?: string;
  initialValues?: Record<string, string>;
}

function buildSchema(parameters: PipelineParameter[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of parameters) {
    if (p.type === "checkbox") {
      shape[p.id] = z.string().optional().default("false");
    } else if (p.required) {
      shape[p.id] = z.string().min(1, `${p.label} is required`);
    } else {
      shape[p.id] = z.string().optional().default("");
    }
  }
  return z.object(shape);
}

function buildDefaults(parameters: PipelineParameter[]) {
  const defaults: Record<string, string> = {};
  for (const p of parameters) {
    if (p.type === "checkbox") {
      defaults[p.id] = p.default === true ? "true" : "false";
    } else if (p.default !== undefined && p.default !== null) {
      defaults[p.id] = String(p.default);
    } else if (p.type === "select" && p.options?.length) {
      defaults[p.id] = p.options[0].value;
    } else {
      defaults[p.id] = "";
    }
  }
  return defaults;
}

export function DynamicForm({
  parameters,
  onSubmit,
  loading,
  submitLabel,
  initialValues,
}: DynamicFormProps) {
  const schema = buildSchema(parameters);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { ...buildDefaults(parameters), ...(initialValues ?? {}) },
  });

  // git-branches dynamic selects: { paramId, sourceParamId, defaultVal }
  const gitBranchDeps = useMemo(
    () =>
      parameters
        .filter((p) => p.source?.startsWith("git-branches:"))
        .map((p) => ({
          paramId: p.id,
          sourceParamId: p.source!.split(":")[1],
          defaultVal: typeof p.default === "string" ? p.default : "",
        })),
    [parameters]
  );

  const [dynamicOptions, setDynamicOptions] = useState<Record<string, PipelineOption[]>>({});
  const [loadingBranches, setLoadingBranches] = useState<Record<string, boolean>>({});
  const [branchError, setBranchError] = useState<Record<string, boolean>>({});

  const formValues = watch() as Record<string, string>;
  const defaults = useMemo(() => buildDefaults(parameters), [parameters]);
  const sourceValues = gitBranchDeps.map((d) => formValues[d.sourceParamId] || defaults[d.sourceParamId]).join("|");

  function fetchBranches(paramId: string, defaultVal: string, repoUrl: string) {
    setLoadingBranches((prev) => ({ ...prev, [paramId]: true }));
    setBranchError((prev) => ({ ...prev, [paramId]: false }));
    gitApi
      .branches(repoUrl)
      .then((res) => {
        let opts = res.data;
        if (defaultVal && !opts.find((o) => o.value === defaultVal)) {
          opts = [{ label: `${defaultVal} (default)`, value: defaultVal }, ...opts];
        }
        setDynamicOptions((prev) => ({ ...prev, [paramId]: opts }));
        const current = (watch() as Record<string, string>)[paramId];
        const keep = opts.find((o) => o.value === current);
        if (!keep) {
          const preferred = opts.find((o) => o.value === defaultVal) ?? opts[0];
          if (preferred) setValue(paramId, preferred.value);
        }
      })
      .catch(() => {
        setBranchError((prev) => ({ ...prev, [paramId]: true }));
        if (defaultVal) {
          setDynamicOptions((prev) => ({
            ...prev,
            [paramId]: [{ label: `${defaultVal} (fallback)`, value: defaultVal }],
          }));
          setValue(paramId, defaultVal);
        } else {
          setDynamicOptions((prev) => ({ ...prev, [paramId]: [] }));
        }
      })
      .finally(() => {
        setLoadingBranches((prev) => ({ ...prev, [paramId]: false }));
      });
  }

  // Debounced fetch whenever a source param value changes
  useEffect(() => {
    if (gitBranchDeps.length === 0) return;
    const timer = setTimeout(() => {
      gitBranchDeps.forEach(({ paramId, sourceParamId, defaultVal }) => {
        const repoUrl = formValues[sourceParamId] || defaults[sourceParamId];
        if (!repoUrl) return;
        fetchBranches(paramId, defaultVal, repoUrl);
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [sourceValues, gitBranchDeps, defaults]);

  function onValid(values: Record<string, unknown>) {
    onSubmit(values as Record<string, string>);
  }

  return (
    <form onSubmit={handleSubmit(onValid)} className="space-y-5">
      {parameters.map((param) => (
        <div key={param.id} className="space-y-1.5">
          <label className="block text-sm font-medium text-zinc-300">
            {param.label}
            {param.required && <span className="text-red-400 ml-1">*</span>}
          </label>

          {param.type === "text" || param.type === "password" ? (
            <Input
              type={param.type}
              placeholder={param.placeholder}
              readOnly={param.readonly}
              {...register(param.id)}
            />
          ) : param.type === "select" && param.source?.startsWith("git-branches:") ? (
            <div className="space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-start gap-2">
                <div className="flex-1 min-w-0">
                  <Controller
                    control={control}
                    name={param.id}
                    render={({ field }) => (
                      <Combobox
                        options={
                          dynamicOptions[param.id]?.length
                            ? dynamicOptions[param.id]
                            : typeof param.default === "string" && param.default
                            ? [{ label: param.default, value: param.default }]
                            : []
                        }
                        value={String(field.value || "")}
                        onChange={field.onChange}
                        loading={loadingBranches[param.id]}
                        disabled={loadingBranches[param.id] || param.readonly}
                        placeholder="Select branch..."
                      />
                    )}
                  />
                </div>
                <button
                  type="button"
                  title="Refresh branches"
                  disabled={loadingBranches[param.id]}
                  onClick={() => {
                    const dep = gitBranchDeps.find((d) => d.paramId === param.id);
                    if (!dep) return;
                    const repoUrl = formValues[dep.sourceParamId] || defaults[dep.sourceParamId];
                    if (repoUrl) fetchBranches(dep.paramId, dep.defaultVal, repoUrl);
                  }}
                  className="flex-shrink-0 h-10 w-full sm:w-10 mt-0 flex items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <svg
                    className={`h-4 w-4 ${loadingBranches[param.id] ? "animate-spin" : ""}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                    <path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                    <path d="M8 16H3v5" />
                  </svg>
                </button>
              </div>
              {branchError[param.id] && (
                <p className="text-[11px] text-amber-400/80">
                  Warning: Could not refresh branches. Using fallback/cached values.
                </p>
              )}
              {!loadingBranches[param.id] && !dynamicOptions[param.id]?.length && !branchError[param.id] && (
                <p className="text-[11px] text-zinc-500">
                  {formValues[param.source.split(":")[1]]
                    ? "No remote branches found. Using default."
                    : "Enter repository URL to load branches."}
                </p>
              )}
            </div>
          ) : param.type === "select" && param.options ? (
            <Select
              options={param.options}
              disabled={param.readonly}
              {...register(param.id)}
            />
          ) : param.type === "checkbox" ? (
            <label className={`flex items-center gap-3 select-none ${param.readonly ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
              <button
                type="button"
                role="checkbox"
                disabled={param.readonly}
                aria-checked={watch(param.id) === "true"}
                onClick={() =>
                  !param.readonly && setValue(param.id, watch(param.id) === "true" ? "false" : "true")
                }
                className={`relative h-5 w-9 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
                  watch(param.id) === "true" ? "bg-violet-600" : "bg-zinc-700"
                }`}
              >
                <span
                  className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    watch(param.id) === "true" ? "translate-x-4" : "translate-x-0.5"
                  }`}
                  style={{ marginTop: "2px" }}
                />
              </button>
              <span className="text-sm text-zinc-400">
                {watch(param.id) === "true" ? "Enabled" : "Disabled"}
              </span>
            </label>
          ) : null}

          {errors[param.id] && (
            <p className="text-xs text-red-400">{String(errors[param.id]?.message)}</p>
          )}
        </div>
      ))}

      <div className="pt-2">
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          {submitLabel ? (
            submitLabel
          ) : (
            <>
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <polygon points="5,3 19,12 5,21" />
              </svg>
              Run Pipeline
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
