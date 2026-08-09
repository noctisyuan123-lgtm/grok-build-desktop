import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Boxes,
  Braces,
  Cable,
  FileCode2,
  FileText,
  Eye,
  Loader2,
  Package,
  Pencil,
  Plus,
  Power,
  RefreshCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useModalFocus } from '../hooks/useModalFocus';
import {
  CUSTOMIZE_TEMPLATES,
  deleteCustomization,
  listCustomizations,
  listCustomizePlugins,
  runPluginAction,
  saveCustomization,
  setCustomizationEnabled,
  setMcpEnabled,
  type CustomizeEntry,
  type CustomizeKind,
  type CustomizeScope,
} from '../lib/customize';
import { addMcpServer, listMcpServers, removeMcpServer } from '../lib/mcp';
import { sanitizeHtml } from '../lib/sanitizeHtml';

type CustomizeTab = CustomizeKind | 'mcp' | 'plugin';

interface Props {
  open: boolean;
  onClose: () => void;
  cwd?: string;
  onOpenCatalog: () => void;
}

const TABS: Array<{
  id: CustomizeTab;
  label: string;
  icon: typeof FileText;
  description: string;
}> = [
  { id: 'rule', label: 'Rules', icon: FileText, description: 'Always-on instructions for Grok.' },
  {
    id: 'command',
    label: 'Commands',
    icon: FileCode2,
    description: 'Legacy flat slash commands discovered by Grok.',
  },
  {
    id: 'skill',
    label: 'Skills',
    icon: Sparkles,
    description: 'Reusable prompt packages with optional scripts and references.',
  },
  {
    id: 'agent',
    label: 'Subagents',
    icon: Bot,
    description: 'Named agents with their own prompt, tools, and context.',
  },
  { id: 'mcp', label: 'MCP', icon: Cable, description: 'External tools and data sources.' },
  {
    id: 'hook',
    label: 'Hooks',
    icon: Braces,
    description: 'Lifecycle automation and safety checks.',
  },
  {
    id: 'plugin',
    label: 'Plugins',
    icon: Package,
    description: 'Installable bundles of Grok capabilities.',
  },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRecords(raw: string): Array<Record<string, unknown>> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
    if (value && typeof value === 'object') {
      for (const key of ['plugins', 'servers', 'mcpServers', 'items']) {
        const nested = (value as Record<string, unknown>)[key];
        if (Array.isArray(nested)) {
          return nested.filter((item) => item && typeof item === 'object');
        }
      }
    }
  } catch {
    // Older Grok versions returned a human-readable list. The raw output is
    // still shown below, rather than pretending it parsed successfully.
  }
  return [];
}

function recordName(record: Record<string, unknown>): string {
  for (const key of ['name', 'id', 'plugin', 'server']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return 'Unnamed';
}

function recordEnabled(record: Record<string, unknown>): boolean {
  if (typeof record.enabled === 'boolean') return record.enabled;
  if (typeof record.disabled === 'boolean') return !record.disabled;
  if (typeof record.status === 'string') return record.status.toLowerCase() !== 'disabled';
  return true;
}

function recordScope(record: Record<string, unknown>): 'user' | 'project' | null {
  return record.scope === 'user' || record.scope === 'project' ? record.scope : null;
}

function MarkdownPreview({ source }: { source: string }) {
  const [html, setHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    setHtml('');
    void import('../lib/markdown').then(({ renderMarkdown }) => {
      if (!cancelled) setHtml(sanitizeHtml(renderMarkdown(source)));
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return html ? (
    <div
      className="customize-markdown-preview markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <div className="customize-rendering">
      <Loader2 className="spin" size={15} /> Rendering preview…
    </div>
  );
}

function FileCustomizePanel({
  kind,
  scope,
  cwd,
}: {
  kind: CustomizeKind;
  scope: CustomizeScope;
  cwd?: string;
}) {
  const [entries, setEntries] = useState<CustomizeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [baseline, setBaseline] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(kind === 'hook');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = content !== baseline;

  const load = async (preferred?: string, preserveNotice = false) => {
    setBusy(true);
    if (!preserveNotice) setNotice(null);
    try {
      const next = await listCustomizations(kind, scope, cwd);
      setEntries(next);
      const target = next.find((entry) => entry.name === (preferred ?? selected)) ?? next[0];
      if (target) {
        setSelected(target.name);
        setName(target.name);
        setContent(target.content);
        setBaseline(target.content);
        setEnabled(target.enabled);
        setEditing(kind === 'hook');
      } else {
        setSelected(null);
        setName('');
        setContent('');
        setBaseline('');
        setEnabled(true);
        setEditing(kind === 'hook');
      }
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, scope, cwd]);

  const choose = (entry: CustomizeEntry) => {
    if (dirty && !window.confirm('Discard the unsaved changes?')) return;
    setSelected(entry.name);
    setName(entry.name);
    setContent(entry.content);
    setBaseline(entry.content);
    setEnabled(entry.enabled);
    setEditing(kind === 'hook');
    setNotice(null);
  };

  const create = () => {
    if (dirty && !window.confirm('Discard the unsaved changes?')) return;
    const nextName = `new-${kind}`;
    setSelected(null);
    setName(nextName);
    const template = CUSTOMIZE_TEMPLATES[kind](nextName);
    setContent(template);
    setBaseline('');
    setEnabled(true);
    setEditing(true);
    setNotice(null);
  };

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const entry = await saveCustomization({ kind, scope, name, content, enabled, cwd });
      setSelected(entry.name);
      setBaseline(entry.content);
      setEditing(kind === 'hook');
      setNotice({ ok: true, text: `Saved and discoverable at ${entry.path}` });
      await load(entry.name, true);
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await setCustomizationEnabled({ kind, scope, name: selected, enabled: !enabled, cwd });
      await load(selected);
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || !window.confirm(`Delete ${kind} “${selected}”?`)) return;
    setBusy(true);
    try {
      await deleteCustomization({ kind, scope, name: selected, cwd });
      setNotice({ ok: true, text: `Deleted ${selected}` });
      setSelected(null);
      await load(undefined, true);
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const filtered = entries.filter((entry) =>
    entry.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="customize-editor-grid">
      <aside className="customize-entry-list">
        <div className="customize-list-actions">
          <label>
            <Search size={14} />
            <input
              aria-label={`Search ${kind}s`}
              placeholder={`Search ${kind}s`}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button type="button" title={`New ${kind}`} aria-label={`New ${kind}`} onClick={create}>
            <Plus size={15} />
          </button>
          <button type="button" title="Refresh" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCcw size={14} />
          </button>
        </div>
        <div className="customize-entry-scroll">
          {filtered.length ? (
            filtered.map((entry) => (
              <button
                type="button"
                key={entry.name}
                className={selected === entry.name ? 'active' : ''}
                onClick={() => choose(entry)}
              >
                <span>{entry.name}</span>
                <small>{entry.enabled ? 'Enabled' : 'Disabled'}</small>
              </button>
            ))
          ) : (
            <p className="customize-empty">No {kind}s in this scope yet.</p>
          )}
        </div>
      </aside>

      <section className="customize-code-editor">
        <div className="customize-editor-toolbar">
          <input
            aria-label={`${kind} name`}
            value={name}
            disabled={selected !== null}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <span className={`customize-state${enabled ? '' : ' disabled'}`}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
          {selected ? (
            <button type="button" disabled={busy} onClick={() => void toggle()}>
              <Power size={14} /> {enabled ? 'Disable' : 'Enable'}
            </button>
          ) : null}
          {kind !== 'hook' ? (
            <button type="button" onClick={() => setEditing((value) => !value)}>
              {editing ? <Eye size={14} /> : <Pencil size={14} />}
              {editing ? 'Preview' : 'Edit'}
            </button>
          ) : null}
          <button type="button" disabled={busy || !name.trim() || !content.trim()} onClick={save}>
            {busy ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Save
          </button>
          {selected ? (
            <button className="danger" type="button" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={14} /> Delete
            </button>
          ) : null}
        </div>
        {kind === 'hook' && scope === 'workspace' ? (
          <div className="customize-warning">
            Workspace hooks run only after Grok trusts this folder. Review the command carefully,
            then grant trust from Grok’s <code>/hooks-trust</code> flow.
          </div>
        ) : null}
        {editing || kind === 'hook' ? (
          <textarea
            className="customize-source"
            aria-label={`${kind} content`}
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
          />
        ) : (
          <MarkdownPreview source={content} />
        )}
        <div className="customize-editor-status">
          <span>{dirty ? 'Unsaved changes' : selected ? 'Saved on disk' : 'New item'}</span>
          {notice ? <strong className={notice.ok ? 'ok' : 'err'}>{notice.text}</strong> : null}
        </div>
      </section>
    </div>
  );
}

function McpCustomizePanel({ cwd, onOpenCatalog }: { cwd?: string; onOpenCatalog: () => void }) {
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [envPairs, setEnvPairs] = useState('');
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async () => {
    setBusy(true);
    try {
      const run = await listMcpServers(cwd, true);
      setRaw(run?.output ?? '');
      if (run && !run.ok) setNotice({ ok: false, text: run.stderr || run.output });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const records = parseRecords(raw);

  const add = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const run = await addMcpServer({
        name,
        command: transport === 'stdio' ? target : undefined,
        args: args.split(/\s+/).filter(Boolean),
        envPairs: envPairs
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        url: transport === 'stdio' ? undefined : target,
        transportType: transport,
        scope,
        cwd,
      });
      setNotice({ ok: Boolean(run?.ok), text: run?.ok ? `Added ${name}` : run?.stderr || 'Failed' });
      if (run?.ok) {
        setName('');
        setTarget('');
        setArgs('');
        setEnvPairs('');
      }
      await refresh();
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const manage = async (
    action: 'enable' | 'disable' | 'remove',
    server: string,
    serverScope: 'user' | 'project' | null,
  ) => {
    setBusy(true);
    try {
      const run =
        action === 'remove'
          ? await removeMcpServer(server, serverScope ?? scope, cwd)
          : await setMcpEnabled(server, action === 'enable', cwd);
      setNotice({
        ok: Boolean(run?.ok),
        text: run?.ok ? `${action}d ${server}` : run?.stderr || run?.output || 'Failed',
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="customize-integrations">
      <section className="customize-add-card">
        <div className="customize-card-title">
          <div>
            <strong>Add custom MCP server</strong>
            <span>Writes through <code>grok mcp add</code>, not app-local storage.</span>
          </div>
          <button type="button" onClick={onOpenCatalog}>
            <Boxes size={14} /> Browse catalog
          </button>
        </div>
        <div className="customize-form-row">
          <select value={scope} onChange={(event) => setScope(event.currentTarget.value as typeof scope)}>
            <option value="user">User</option>
            <option value="project" disabled={!cwd}>Workspace</option>
          </select>
          <input placeholder="Server name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <select
            value={transport}
            onChange={(event) => setTransport(event.currentTarget.value as typeof transport)}
          >
            <option value="stdio">stdio</option>
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
          </select>
          <input
            className="grow"
            placeholder={transport === 'stdio' ? 'Command, e.g. npx' : 'https://…'}
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
          />
        </div>
        <div className="customize-form-row">
          <input
            className="grow"
            placeholder="Arguments (space separated)"
            value={args}
            onChange={(e) => setArgs(e.currentTarget.value)}
          />
          <input
            className="grow"
            placeholder="Environment: KEY=value (one per line)"
            value={envPairs}
            onChange={(e) => setEnvPairs(e.currentTarget.value)}
          />
          <button type="button" disabled={busy || !name.trim() || !target.trim()} onClick={() => void add()}>
            {busy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} Add
          </button>
        </div>
      </section>

      <section className="customize-records">
        <div className="customize-card-title">
          <strong>Configured servers</strong>
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            <RefreshCcw size={14} /> Refresh
          </button>
        </div>
        {records.length ? (
          records.map((record) => {
            const server = recordName(record);
            const enabled = recordEnabled(record);
            const serverScope = recordScope(record);
            return (
              <div className="customize-record" key={`${serverScope ?? 'effective'}:${server}`}>
                <div>
                  <strong>{server}</strong>
                  <small>{serverScope ? `${serverScope} · ` : ''}{enabled ? 'Enabled' : 'Disabled'}</small>
                </div>
                <button type="button" disabled={busy} onClick={() => void manage(enabled ? 'disable' : 'enable', server, serverScope)}>
                  <Power size={14} /> {enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="danger" type="button" disabled={busy} onClick={() => void manage('remove', server, serverScope)}>
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            );
          })
        ) : (
          <pre className="customize-raw">{raw || 'No MCP servers configured.'}</pre>
        )}
      </section>
      {notice ? <div className={`customize-notice ${notice.ok ? 'ok' : 'err'}`}>{notice.text}</div> : null}
    </div>
  );
}

function PluginCustomizePanel({ cwd }: { cwd?: string }) {
  const [raw, setRaw] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async () => {
    setBusy(true);
    try {
      const run = await listCustomizePlugins(cwd);
      setRaw(run?.output ?? '');
      if (run && !run.ok) setNotice({ ok: false, text: run.stderr || run.output });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const records = parseRecords(raw);

  const action = async (
    operation: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'details',
    value: string | null,
  ) => {
    setBusy(true);
    setNotice(null);
    try {
      const run = await runPluginAction(operation, value, cwd);
      setNotice({
        ok: Boolean(run?.ok),
        text: run?.ok ? run.output || `${operation} complete` : run?.stderr || 'Plugin action failed',
      });
      if (run?.ok && operation === 'install') setSource('');
      if (operation !== 'details') await refresh();
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="customize-integrations">
      <section className="customize-add-card">
        <div className="customize-card-title">
          <div>
            <strong>Install plugin</strong>
            <span>Git URL, GitHub shorthand, or local path. Installation explicitly trusts the source.</span>
          </div>
          <button type="button" disabled={busy} onClick={() => void action('update', null)}>
            <RefreshCcw size={14} /> Update all
          </button>
        </div>
        <div className="customize-form-row">
          <input
            className="grow"
            placeholder="owner/repo, git URL, or local path"
            value={source}
            onChange={(event) => setSource(event.currentTarget.value)}
          />
          <button type="button" disabled={busy || !source.trim()} onClick={() => void action('install', source)}>
            {busy ? <Loader2 className="spin" size={14} /> : <Plus size={14} />} Install & trust
          </button>
        </div>
      </section>

      <section className="customize-records">
        <div className="customize-card-title">
          <strong>Installed plugins</strong>
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            <RefreshCcw size={14} /> Refresh
          </button>
        </div>
        {records.length ? (
          records.map((record) => {
            const plugin = recordName(record);
            const enabled = recordEnabled(record);
            return (
              <div className="customize-record" key={plugin}>
                <div>
                  <strong>{plugin}</strong>
                  <small>{enabled ? 'Enabled' : 'Disabled'}</small>
                </div>
                <button type="button" disabled={busy} onClick={() => void action('details', plugin)}>
                  Details
                </button>
                <button type="button" disabled={busy} onClick={() => void action(enabled ? 'disable' : 'enable', plugin)}>
                  <Power size={14} /> {enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="danger" type="button" disabled={busy} onClick={() => void action('uninstall', plugin)}>
                  <Trash2 size={14} /> Uninstall
                </button>
              </div>
            );
          })
        ) : (
          <pre className="customize-raw">{raw || 'No plugins installed.'}</pre>
        )}
      </section>
      {notice ? <div className={`customize-notice ${notice.ok ? 'ok' : 'err'}`}>{notice.text}</div> : null}
    </div>
  );
}

export function CustomizePage({ open, onClose, cwd, onOpenCatalog }: Props) {
  const [tab, setTab] = useState<CustomizeTab>('rule');
  const [scope, setScope] = useState<CustomizeScope>('user');
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(open, modalRef, { initialFocus: closeRef, onEscape: onClose });

  const tabMeta = useMemo(() => TABS.find((item) => item.id === tab) ?? TABS[0], [tab]);
  if (!open) return null;

  return (
    <div className="settings-overlay customize-overlay" role="dialog" aria-modal="true" aria-label="Customize Grok" onClick={onClose}>
      <div className="customize-modal" ref={modalRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <aside className="customize-nav">
          <div className="customize-brand">
            <Boxes size={18} />
            <div>
              <strong>Customize</strong>
              <span>Grok capabilities</span>
            </div>
          </div>
          <nav aria-label="Customize sections">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={tab === item.id ? 'active' : ''}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="customize-scope-note">
            <strong>Native storage</strong>
            <span>Everything here is read by Grok itself. No app-only shadow configuration.</span>
          </div>
        </aside>

        <main className="customize-main">
          <header className="customize-head">
            <div>
              <h2>{tabMeta.label}</h2>
              <p>{tabMeta.description}</p>
            </div>
            {tab !== 'mcp' && tab !== 'plugin' ? (
              <div className="customize-scope" aria-label="Customization scope">
                <button type="button" className={scope === 'user' ? 'active' : ''} onClick={() => setScope('user')}>
                  User
                </button>
                <button
                  type="button"
                  className={scope === 'workspace' ? 'active' : ''}
                  disabled={!cwd}
                  title={cwd ? cwd : 'Choose a project folder first'}
                  onClick={() => setScope('workspace')}
                >
                  Workspace
                </button>
              </div>
            ) : null}
            <button ref={closeRef} type="button" className="customize-close" aria-label="Close Customize" onClick={onClose}>
              <X size={18} />
            </button>
          </header>

          <div className="customize-body">
            {tab === 'mcp' ? (
              <McpCustomizePanel cwd={cwd} onOpenCatalog={onOpenCatalog} />
            ) : tab === 'plugin' ? (
              <PluginCustomizePanel cwd={cwd} />
            ) : (
              <FileCustomizePanel kind={tab} scope={scope} cwd={cwd} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
