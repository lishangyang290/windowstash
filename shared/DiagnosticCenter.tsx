import React, { useMemo, useRef, useState } from 'react';
import { differentDevice, eventNames, importBundle, makeBundle, type DiagnosticBundle, type DiagnosticEvent } from './diagnostics';
import { evidenceForOperation, groupDiagnosticFindings, type IssueGroup } from './diagnosticPresentation';
import logo from '../public/icon-128.png';
import { DiagnosticSelect } from './DiagnosticSelect';
import './diagnostics.css';
import { prepareDiagnosticExport } from './diagnosticExport';
import { diagnosticTiming, yieldDiagnosticUI } from './diagnosticTiming';

type View = 'issues' | 'events' | 'status';
function initialView(): View {
  const value = globalThis.location ? new URL(location.href).searchParams.get('view') : null;
  return value === 'events' || value === 'status' ? value : 'issues';
}
const PAGE_SIZE = 40;
const labels: Record<string, string> = {
  extension: 'Chrome 扩展', companion: 'Companion', 'native-host': 'Native Host', 'companion-rust': '桌面服务',
  started: '开始', success: '完成', waiting: '等待', failed: '失败', cancelled: '已取消', observed: '状态记录',
  confirmed: '已记录的异常', suspected: '需要核实', insufficient: '证据不完整',
};
const stamp = (at?: string | null) => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '未知';
const timeOnly = (at?: string | null) => at && Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '未知';
const category = (e: DiagnosticEvent) => e.state.action === 'remove' || e.state.action === 'delete' || e.event === 'local.deleted' ? '删除'
  : e.state.action === 'update' ? '修改' : ['save', 'save-close', 'put'].includes(String(e.state.action)) ? '保存'
    : e.event.startsWith('realtime.') || e.event.startsWith('lifecycle.') ? '连接' : '同步';
const eventLabel = (e?: DiagnosticEvent) => e ? eventNames[e.event] ?? e.event : '未记录到';
const stateLabel = (result: string) => labels[result] ?? result;
const componentLabel = (component: string) => labels[component] ?? component;

function download(bundle: DiagnosticBundle, json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url;
  anchor.download = `windowstash-diagnostics-${bundle.exportedAt.replace(/[:.]/g, '-')}.json`;
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function EvidenceStatus({ group }: { group: IssueGroup }) {
  const count = group.findings.length;
  return <span className={`diag-confidence diag-confidence--${group.confidence}`}>{labels[group.confidence]}{count > 1 ? ` · ${count} 条线索` : ''}</span>;
}
function IssueDetail({ issue, bundle, onEvidence, onCopy }: {
  issue: IssueGroup; bundle: DiagnosticBundle; onEvidence: (id: string) => void; onCopy: (value: string) => void;
}) {
  const findings = issue.findings;
  const events = new Map(bundle.events.map(e => [e.id, e]));
  const anchor = issue.anchor;
  return <>
    <div className="diag-pane-header"><div className="diag-detail-title"><h2>{issue.representative.symptom}</h2><EvidenceStatus group={issue}/></div><p>以下是已采集记录推导出的排查方向，不代表所有根因都已确认。</p></div>
    <div className="diag-pane-body">
      <div className="diag-evidence-head"><b>目前能确定什么</b></div>
      <p className="diag-readable">{issue.representative.hypothesis}</p>
      <dl className="diag-detail-pairs">
        <div><dt>相关位置</dt><dd>{anchor ? componentLabel(anchor.component) : '记录不足'}</dd></div>
        <div><dt>最后线索</dt><dd>{anchor ? `${eventLabel(anchor)} · ${timeOnly(anchor.timestamp)}` : '尚未找到对应事件'}</dd></div>
        <div><dt>源码模块</dt><dd><code>{issue.representative.source.join('、') || anchor?.source || '未记录'}</code></dd></div>
      </dl>
      <div className="diag-evidence-head"><b>建议检查</b></div>
      <p className="diag-readable">{issue.representative.check}</p>
      <div className="diag-evidence-head"><b>关联证据</b><span>{issue.eventIds.filter(id => events.has(id)).length} 条</span></div>
      <div className="diag-evidence-list">
        {issue.eventIds.filter(id => events.has(id)).slice(0, 12).map(id => { const e = events.get(id)!; return <button key={id} className="diag-evidence-link" onClick={() => onEvidence(id)}>
          <span className="diag-evidence-time">{timeOnly(e.timestamp)}</span><span>{eventLabel(e)}</span><span className="diag-link-arrow">查看 →</span>
        </button>; })}
        {!issue.eventIds.some(id => events.has(id)) && <p className="diag-empty-small">没有可访问的关联事件。</p>}
      </div>
      {findings.length > 1 && <details className="diag-disclosure"><summary>其他 {findings.length - 1} 条同操作线索</summary><ul>{findings.filter(f => f !== issue.representative).map((f,i) => <li key={i}>{f.symptom}</li>)}</ul></details>}
      {!!issue.representative.missing.length && <details className="diag-disclosure"><summary>尚缺少的证据</summary><ul>{issue.representative.missing.map((x,i) => <li key={i}>{x}</li>)}</ul></details>}
      <button className="diag-secondary diag-copy-issue" onClick={() => onCopy(JSON.stringify(issue.findings, null, 2))}>复制开发者分析数据</button>
    </div>
  </>;
}
const stages: [string, string[]][] = [
  ['本机保存 / 删除', ['local.persisted', 'local.deleted']],
  ['Native Host 持久化', ['native.persisted', 'native.publish.persisted']],
  ['进入云端队列', ['queue.upload', 'queue.delete']],
  ['Supabase 请求发起', ['cloud.start']],
  ['云端确认', ['cloud.version', 'cloud.done']],
  ['另一设备收到 Realtime 事件', ['realtime.event']],
  ['本机完成校准', ['native.applied']],
  ['界面已提交更新', ['ui.committed']],
];
function TraceDetail({ active, bundle, onCopy, onSelect, problem }: {
  active: DiagnosticEvent; bundle: DiagnosticBundle; onCopy: (value: string) => void; onSelect: (id: string) => void; problem?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const header = useRef<HTMLDivElement>(null);
  const preserveScroll = useRef(false);
  const trace = useMemo(() => evidenceForOperation(bundle, active), [active, bundle]);
  const ordered = [...trace].sort((a,b) => a.timestamp.localeCompare(b.timestamp));
  const position = ordered.findIndex(e => e.id === active.id);
  const start = showAll ? 0 : Math.floor(Math.max(0, position) / 5) * 5;
  const subset = showAll ? ordered : ordered.slice(start, start + 5);
  React.useEffect(() => {
    if (!preserveScroll.current) header.current?.closest('.diag-detail-pane')?.scrollTo(0, 0);
    preserveScroll.current = false;
  }, [active.id]);
  const observed = stages.map(([name, names]) => {
    const matched = trace.filter(e => names.includes(e.event) && (name !== '另一设备收到 Realtime 事件' || differentDevice(active, e)));
    return { name, matched };
  });
  const seen = observed.filter(x => x.matched.length), unavailable = observed.filter(x => !x.matched.length);
  return <>
    <div className="diag-pane-header diag-trace-header" ref={header}>
      <div className="diag-detail-title"><h2>{eventLabel(active)}</h2><span className={`diag-result diag-result--${active.result}`}>{stateLabel(active.result)}</span></div>
      <div className="diag-trace-meta"><span>{componentLabel(active.component)} · {stamp(active.timestamp)}</span><span>关联记录 {position + 1} / {ordered.length}</span></div>
      {problem && <p className="diag-trace-context" title={problem}>来源问题：{problem}</p>}
    </div>
    <div className="diag-pane-body">
      <div className="diag-summary-strip"><div><strong>{trace.length}</strong><span>有证据事件</span></div><div><strong>{seen.length}/{stages.length}</strong><span>有记录阶段</span></div><div><strong>{trace.filter(e=>e.result==='failed').length}</strong><span>失败记录</span></div></div>
      <section className="diag-selected-event" aria-label="当前选中事件详情">
        <div className="diag-evidence-head"><b>当前选中事件</b><span>与左侧选中行对应</span></div>
        <dl className="diag-detail-pairs">
          {active.workspaceRef && <div><dt>工作区标识</dt><dd><code title={active.workspaceRef}>{active.workspaceRef.slice(0, 8)}</code>（脱敏）</dd></div>}
          {active.cloudVersion && <div><dt>云端版本</dt><dd><code>{active.cloudVersion}</code></dd></div>}
          {active.durationMs !== undefined && <div><dt>执行耗时</dt><dd>{active.durationMs} ms</dd></div>}
          {active.errorCode && <div><dt>错误码</dt><dd>{active.errorCode}</dd></div>}
          <div><dt>源码位置</dt><dd><code>{active.source}</code></dd></div>
        </dl>
      </section>
      <div className="diag-evidence-head"><b>关联操作时间线</b><span>{showAll || ordered.length <= 5 ? '仅依据明确关联证据' : `当前显示第 ${start + 1}–${start + subset.length} 条`}</span></div>
      <ol className="diag-timeline">
        {subset.map(e => <li key={e.id} data-trace-event-id={e.id} aria-current={e.id === active.id ? 'step' : undefined} className={`diag-timeline-${e.result} ${e.id === active.id ? 'diag-timeline-current' : ''}`}>
          <div className="diag-step-card">
          <button className="diag-step-choice" onClick={() => { if (e.id !== active.id) { preserveScroll.current = true; onSelect(e.id); } }} aria-label={`查看步骤：${eventLabel(e)}`}>
            <span className="diag-timeline-title"><span>{eventLabel(e)}</span><em>{e.id === active.id ? '当前选中' : stateLabel(e.result)}</em></span>
            <span className="diag-timeline-meta">{timeOnly(e.timestamp)} · {componentLabel(e.component)}{e.durationMs !== undefined ? ` · ${e.durationMs} ms` : ''}</span>
            {e.errorCode && <span className="diag-error-line">错误码：{e.errorCode}</span>}
          </button>
          <details className="diag-step-fields"><summary>查看此步骤的技术字段</summary><div className="diag-technical"><code>{e.source}</code><pre>{JSON.stringify(e, null, 2)}</pre><button className="diag-secondary" onClick={() => onCopy(JSON.stringify(e, null, 2))}>复制这条记录</button></div></details>
          </div>
        </li>)}
      </ol>
      {ordered.length > 5 && <button className="diag-secondary diag-wide" onClick={() => setShowAll(v => !v)}>{showAll ? '收起完整过程' : `展开全部 ${ordered.length} 条关联事件`}</button>}
      <div className="diag-evidence-head diag-evidence-head--stages"><b>关键阶段核对</b><span>未记录 ≠ 未执行</span></div>
      <div className="diag-stage-list">{seen.map(({name,matched}) => <div className="diag-stage" key={name}><span className="diag-dot diag-dot--seen"/><span>{name}</span><small>{matched.length} 条证据</small></div>)}</div>
      {!!unavailable.length && <details className="diag-disclosure diag-missing">
        <summary>暂无证据的阶段 <span className="diag-stage-count">{unavailable.length}</span></summary>
        <p className="diag-missing-note">以下阶段缺少可访问的记录，不代表未执行。</p>
        <div className="diag-missing-stages" role="list">{unavailable.map(({name}, index) => <div className="diag-missing-stage" role="listitem" key={name}><span className="diag-stage-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span>{name}</span></div>)}</div>
      </details>}
      <div className="diag-note">本地时间与另一台设备可能存在偏差；不能仅凭时间相近推断因果。</div>
    </div>
  </>;
}

export function DiagnosticCenter({ load, enableDetails, save }: { load: (onPartial?: (bundle: DiagnosticBundle) => void) => Promise<DiagnosticBundle>; enableDetails: () => Promise<void>; save?: (bundle: DiagnosticBundle) => Promise<string> }) {
  const [bundle, setBundle] = useState<DiagnosticBundle>(() => makeBundle([]));
  const [view, setView] = useState<View>(initialView);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [exportStage, setExportStage] = useState('');
  const exporting = useRef(false);
  const [reading, setReading] = useState(true), [hasRead, setHasRead] = useState(false);
  const [query, setQuery] = useState(''), [level, setLevel] = useState(''), [component, setComponent] = useState(''), [kind, setKind] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [evidenceScope, setEvidenceScope] = useState<{ title: string; anchorId: string; ids: string[] } | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const accountRevision = useRef(0), readRevision = useRef(0), importedEvents = useRef<DiagnosticEvent[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  async function exportDiagnostics() {
    if (busy || exporting.current) return;
    exporting.current = true;
    setBusy(true); setExportStage('正在读取日志'); setMessage('正在读取日志');
    const revision = accountRevision.current, imported = importedEvents.current;
    const current = () => revision === accountRevision.current;
    const started = performance.now();
    let stage = '读取日志';
    try {
      await yieldDiagnosticUI();
      const readStart = performance.now();
      const latest = await load();
      diagnosticTiming('read-all', readStart);
      if (!current()) return;
      stage = '整理数据'; setExportStage('正在整理数据'); setMessage('正在整理数据');
      await yieldDiagnosticUI();
      const prepared = await prepareDiagnosticExport(latest, imported);
      if (!current()) return;
      stage = '生成文件'; setExportStage('正在生成文件'); setMessage('正在生成文件');
      await yieldDiagnosticUI();
      if (!current()) return;
      const saveStart = performance.now();
      if (save) {
        const path = await save(prepared.bundle);
        if (current()) setMessage(`已导出：${path}`);
      } else { download(prepared.bundle, prepared.json); setMessage('诊断文件已生成，已交给浏览器下载；请查看下载列表。'); }
      diagnosticTiming('file-save', saveStart);
      if (current()) setBundle(prepared.bundle);
    } catch (error) {
      // File paths and arbitrary transport messages may contain private data.
      const known = error instanceof Error && /^(诊断数据整理超时，请重试|诊断文件生成线程不可用，请重试|诊断数据整理或序列化失败)$/.test(error.message) ? error.message
        : typeof error === 'string' && ['downloads_unavailable', 'diagnostic_export_failed', 'diagnostic_bundle_too_large', 'invalid_diagnostic_bundle'].includes(error) ? error : `${stage}未完成，请检查组件授权和下载目录权限后重试`;
      if (current()) setMessage(`导出失败：${known}；诊断记录仍保留在本机。`);
    } finally {
      diagnosticTiming('export-total', started);
      exporting.current = false;
      if (current()) { setBusy(false); setExportStage(''); }
    }
  }
  const refresh = React.useCallback(async () => {
    setBusy(true); setReading(true); const revision = accountRevision.current, request = ++readRevision.current;
    const current = () => revision === accountRevision.current && request === readRevision.current;
    const apply = (latest: DiagnosticBundle) => {
      if (!current()) return;
      setBundle(importedEvents.current.length ? makeBundle([...latest.events, ...importedEvents.current], latest.coverage) : latest);
      setHasRead(true);
    };
    try {
      const latest = await load(apply); if (!current()) return;
      apply(latest); setMessage('');
    } catch { if (current()) setMessage('无法读取部分诊断记录；未修改工作区。请检查组件授权或重试。'); }
    finally { if (current()) { setBusy(false); setReading(false); } }
  }, [load]);
  React.useEffect(() => { document.title = '诊断中心 · WindowStash'; void refresh(); }, [refresh]);
  React.useEffect(() => {
    if (!globalThis.location || !globalThis.history) return;
    const url = new URL(location.href); url.searchParams.set('view', view);
    history.replaceState(history.state, '', url);
  }, [view]);
  React.useEffect(() => {
    const clear = () => { accountRevision.current++; readRevision.current++; importedEvents.current = []; setBundle(makeBundle([])); setSelectedId(null); setSelectedIssueKey(null); setEvidenceScope(null); setHasRead(false); setReading(false); setBusy(false); setExportStage(''); setMessage('账号已变化，已隐藏旧账号诊断记录；请刷新。'); };
    window.addEventListener('windowstash-diagnostic-account-changed', clear);
    return () => window.removeEventListener('windowstash-diagnostic-account-changed', clear);
  }, []);
  const issues = useMemo(() => groupDiagnosticFindings(bundle), [bundle]);
  const selectedIssue = issues.find(x => x.key === selectedIssueKey) ?? issues[0];
  const events = bundle.events;
  const evidenceIds = useMemo(() => {
    if (!evidenceScope) return null;
    const anchor = events.find(e => e.id === evidenceScope.anchorId);
    return new Set([...evidenceScope.ids, ...(anchor ? evidenceForOperation(bundle, anchor).map(e => e.id) : [])]);
  }, [evidenceScope, bundle, events]);
  const filtered = useMemo(() => [...events].reverse().filter(e => (!evidenceIds || evidenceIds.has(e.id)) && (!level || e.level === level) && (!component || e.component === component) && (!kind || category(e) === kind)
    && (!from || Date.parse(e.timestamp) >= new Date(from).getTime()) && (!to || Date.parse(e.timestamp) <= new Date(to).getTime())
    && (!query || [eventLabel(e), e.event, e.operationId, e.workspaceRef, e.source, e.errorCode].join(' ').toLowerCase().includes(query.toLowerCase()))), [events, evidenceIds, query, level, component, kind, from, to]);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = visible.find(e => e.id === selectedId) ?? (view === 'events' ? visible[0] : undefined);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  React.useEffect(() => { if (!reading) setPage(current => Math.min(current, pages - 1)); }, [pages, reading]);
  React.useEffect(() => { if (!selected || view !== 'events') return; const node = listRef.current?.querySelector(`[data-event-id="${selected.id}"]`); node?.scrollIntoView({ block: 'nearest' }); }, [selected?.id, page, view]);
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setMessage('已复制到剪贴板'); } catch { setMessage('剪贴板不可用，请使用导出诊断日志。'); } }
  function focusEvidence(id: string, issue?: IssueGroup, keepScope = false) {
    const event = events.find(e => e.id === id);
    if (!event) { if (!issue) { setEvidenceScope(null); setPage(0); } else setMessage('这条证据已不在当前记录中，请刷新或导入对应日志。'); return; }
    const scope = issue ? { title: issue.representative.symptom, anchorId: id, ids: [...new Set([...issue.eventIds, ...evidenceForOperation(bundle, event).map(e => e.id)])] } : keepScope && evidenceScope ? { ...evidenceScope, ids: [...(evidenceIds ?? [])] } : null;
    const ids = scope ? new Set(scope.ids) : null;
    const index = [...events].reverse().filter(e => !ids || ids.has(e.id)).findIndex(e => e.id === id);
    setEvidenceScope(scope);
    setQuery(''); setLevel(''); setComponent(''); setKind(''); setFrom(''); setTo('');
    setSelectedId(id); setPage(index >= 0 ? Math.floor(index / PAGE_SIZE) : 0);
    setView('events'); setMobileDetail(true);
  }
  function switchView(next: View) { setView(next); setMobileDetail(false); setMessage(''); }
  const currentIssueCount = issues.length;
  const last = (name: string) => events.filter(e => e.event === name).at(-1);
  const recentSuccess = events.filter(e => e.event === 'cloud.version' || e.event === 'cloud.done' && ['put','remove'].includes(String(e.state.action))).at(-1);
  const recentFailure = events.filter(e => e.result === 'failed').at(-1);
  const observedStates: {name:string;value:string;at?:string;detail?:string}[] = [
    { name: '设备平台', value: (bundle.environment.platforms ?? '').split(', ').map(platform => ({ windows: 'Windows', macos: 'macOS', linux: 'Linux', unknown: '未知' } as Record<string, string>)[platform] ?? platform).join('、') || '未知', detail: '来自本次已采集或导入的记录' },
    { name: 'Chrome 扩展', value: bundle.coverage.extension ?? '未取得记录', detail: '采集覆盖状态，不代表当前在线' },
    { name: 'Native Host', value: bundle.coverage['native-host'] ?? '未取得记录', detail: '最近一次可访问性记录' },
    { name: 'Companion', value: bundle.coverage.companion ?? '未取得记录', detail: '可能已经退出或不在前台' },
    { name: '云端写入', value: recentSuccess ? '最近记录到云端确认' : '未找到确认记录', at: recentSuccess?.timestamp },
    { name: 'Realtime', value: last('realtime.status') ? ({ SUBSCRIBED: '当时已连接并订阅', CLOSED: '当时订阅已断开', CHANNEL_ERROR: '当时连接发生异常', TIMED_OUT: '当时连接超时' } as Record<string, string>)[String(last('realtime.status')?.state.status)] ?? '订阅状态未知' : '未找到订阅状态记录', at: last('realtime.status')?.timestamp },
    { name: '云端实际接收', value: last('realtime.event') ? '最近记录到事件' : '未找到事件记录', at: last('realtime.event')?.timestamp },
    { name: '同步队列', value: last('queue.snapshot') ? `最近快照 ${Number(last('queue.snapshot')?.state.pending ?? 0) + Number(last('queue.snapshot')?.state.deleted ?? 0)} 项` : '未取得队列状态', at: last('queue.snapshot')?.timestamp },
    { name: '最近异常', value: recentFailure ? eventLabel(recentFailure) : '保留范围内未记录到', at: recentFailure?.timestamp },
  ];
  return <main className="diagnostics">
    <header className="diag-header">
      <div className="diag-heading"><div className="diag-wordmark"><img className="diag-mark" src={logo} alt="" /> WindowStash <span className="diag-slash">/</span> 诊断</div><h1>诊断中心</h1><p>把分散的技术记录整理成可以排查的故障线索。</p></div>
      <div className="diag-actions"><button disabled={busy} className="diag-secondary" onClick={() => void refresh()}>刷新</button>
        <label className="diag-file diag-secondary">导入诊断文件<input type="file" disabled={!!exportStage} accept=".json,application/json" onChange={e => { const revision = accountRevision.current, file = e.target.files?.[0]; if (!file) return; if (file.size > 20 * 1024 * 1024) { setMessage('诊断文件超过 20 MiB'); e.target.value = ''; return; }
          void file.text().then(raw => { if (revision !== accountRevision.current) return; const imported = importBundle(raw); importedEvents.current = [...new Map([...importedEvents.current, ...imported.events].map(event => [event.id, event])).values()].slice(-20_000);
            setBundle(previous => makeBundle([...previous.events, ...imported.events], { ...previous.coverage, imported: '已导入另一份诊断记录；设备时钟可能存在偏差' })); setMessage('诊断文件已合并，可以按精确关联证据对照两台设备。'); }).catch(() => setMessage('无法导入：文件格式无效或超过容量限制')); e.target.value = ''; }} /></label>
        <button className="diag-primary" disabled={busy} aria-busy={!!exportStage} title={exportStage || undefined} onClick={() => void exportDiagnostics()}>{exportStage && <span className="diag-spinner" aria-hidden="true"/>}{exportStage ? '正在导出…' : '导出诊断文件'}</button>
      </div>
    </header>
    {reading && <div className="diag-loading" role="status"><span className="diag-loading-dot" aria-hidden="true"/>{hasRead ? '已显示本地记录，正在补齐其他组件；分析结果可能随记录更新。' : '正在读取本机诊断记录…'}</div>}
    {message && <div className="diag-message" role="status">{message}<button onClick={() => setMessage('')} aria-label="关闭提示">×</button></div>}
    <div className="diag-toolbar"><nav aria-label="诊断视图">
      <button className={view === 'issues' ? 'diag-tab-active' : ''} aria-current={view === 'issues' ? 'page' : undefined} onClick={() => switchView('issues')}>问题线索 <span>{currentIssueCount}</span></button>
      <button className={view === 'events' ? 'diag-tab-active' : ''} aria-current={view === 'events' ? 'page' : undefined} onClick={() => switchView('events')}>事件记录 <span>{events.length}</span></button>
      <button className={view === 'status' ? 'diag-tab-active' : ''} aria-current={view === 'status' ? 'page' : undefined} onClick={() => switchView('status')}>采集状态</button>
    </nav><div className="diag-toolbar-info">记录范围 {stamp(bundle.range.from)} — {stamp(bundle.range.to)}</div></div>
    {view === 'issues' && <div className={`diag-workspace ${mobileDetail ? 'diag-show-detail' : ''}`}>
      <section className="diag-list-pane" aria-label="问题线索列表"><div className="diag-pane-intro"><strong>发现 {currentIssueCount} 组值得排查的线索</strong><p>{bundle.findings.length} 条分析归并为操作组。没有记录不代表一定正常。</p></div>
        <div className="diag-scroller diag-issue-scroll">
          {issues.map(issue => <button key={issue.key} className={`diag-issue-row ${selectedIssue?.key===issue.key?'diag-selected':''}`} onClick={() => { setSelectedIssueKey(issue.key); setMobileDetail(true); }}>
            <div className="diag-issue-row-head"><EvidenceStatus group={issue}/><time>{stamp(issue.timestamp)}</time></div>
            <strong>{issue.representative.symptom}</strong><p>{issue.representative.hypothesis}</p>
            <span className="diag-issue-row-foot">{issue.anchor ? componentLabel(issue.anchor.component) : '来源不明'} <span>查看详情 →</span></span>
          </button>)}
          {!issues.length && <div className="diag-empty"><strong>{reading ? '正在整理问题线索…' : '尚无可以归类的故障线索'}</strong><p>{reading ? '正在读取可访问组件的日志。已读到的事件可以先在事件记录中查看。' : '这不等于系统没有问题。可以查看事件记录或导入另一台设备的诊断文件。'}</p><button className="diag-secondary" onClick={() => switchView('events')}>查看事件记录</button></div>}
        </div>
      </section>
      <aside className="diag-detail-pane" aria-label="故障详情">
        <button className="diag-back" onClick={() => setMobileDetail(false)}>← 返回问题列表</button>
        {selectedIssue ? <IssueDetail issue={selectedIssue} bundle={bundle} onEvidence={id => focusEvidence(id, selectedIssue)} onCopy={value => void copy(value)}/> : <div className="diag-empty-small">选择一条线索查看详情。</div>}
      </aside>
    </div>}
    {view === 'events' && <div className={`diag-workspace ${mobileDetail ? 'diag-show-detail' : ''}`}>
      <section className="diag-list-pane" aria-label="事件记录列表">
        <div className="diag-event-controls">
          {evidenceScope && <div className="diag-evidence-scope" role="status"><div><strong>当前问题的关联证据</strong><p>{evidenceScope.title}</p><span>仅显示这条问题的记录，已隐藏其他事件。</span></div><button className="diag-secondary" onClick={() => focusEvidence(selected?.id ?? evidenceScope.ids[0]!)}>查看全部事件</button></div>}
          <div className="diag-quick-filters"><input aria-label="搜索诊断记录" placeholder="搜索事件、源码或错误码" value={query} onChange={e => {setQuery(e.target.value); setPage(0);}} />
          <DiagnosticSelect label="日志级别" value={level} options={[["", "所有级别"], ["INFO", "信息"], ["WARN", "警告"], ["ERROR", "错误"]]} onChange={value => {setLevel(value);setPage(0);}} />
          <DiagnosticSelect label="来源组件" value={component} options={[["", "所有组件"], ...['extension','companion','native-host','companion-rust'].map(x => [x, componentLabel(x)] as [string,string])]} onChange={value => {setComponent(value);setPage(0);}} />
          <button className="diag-secondary diag-filter-button" aria-expanded={advanced} onClick={() => setAdvanced(v => !v)}>更多筛选 {advanced ? '−' : '+'}</button></div>
          {advanced && <div className="diag-advanced">
            <div className="diag-filter-field"><span>事件分类</span><DiagnosticSelect label="事件分类" value={kind} options={[["", "全部分类"], ...['保存','修改','删除','连接','同步'].map(x => [x,x] as [string,string])]} onChange={value => {setKind(value);setPage(0);}} /></div>
            <button className="diag-secondary diag-filter-reset" onClick={() => {setQuery('');setLevel('');setComponent('');setKind('');setFrom('');setTo('');setPage(0);}}>重置筛选</button>
            <label className="diag-filter-field diag-time-field">起始时间<input aria-label="起始时间" type="datetime-local" value={from} onChange={e => {setFrom(e.target.value);setPage(0);}}/></label>
            <label className="diag-filter-field diag-time-field">结束时间<input aria-label="结束时间" type="datetime-local" value={to} onChange={e => {setTo(e.target.value);setPage(0);}}/></label>
          </div>}

        </div>
        <div ref={listRef} className="diag-scroller diag-event-scroll"><table className="diag-event-table"><thead><tr><th>时间</th><th>来源</th><th>事件</th><th title="只表示这一条事件对应阶段的结果，不代表整次同步结果">阶段结果</th></tr></thead><tbody>
          {visible.map(e => <tr key={e.id} data-event-id={e.id} className={selected?.id===e.id?'diag-current':''} onClick={()=>{setSelectedId(e.id);setMobileDetail(true);}}><td>{timeOnly(e.timestamp)}</td><td>{componentLabel(e.component)}</td><td><button className="diag-event-choice" aria-pressed={selected?.id===e.id}>{eventLabel(e)}</button></td><td><span className={`diag-result diag-result--${e.result}`}>{stateLabel(e.result)}</span></td></tr>)}
        </tbody></table>{!filtered.length && <div className="diag-empty-small">{reading ? '正在读取事件，请稍候…' : '没有符合条件的事件。'}</div>}</div>
        <div className="diag-pagination"><span>第 {page+1} / {pages} 页 · 共 {filtered.length} 条</span><div><button disabled={page===0} onClick={()=>{setPage(p=>p-1);listRef.current?.scrollTo(0,0);}}>上一页</button><button disabled={page+1>=pages} onClick={()=>{setPage(p=>p+1);listRef.current?.scrollTo(0,0);}}>下一页</button></div></div>
      </section>
      <aside className="diag-detail-pane" aria-label="操作追踪详情"><button className="diag-back" onClick={() => setMobileDetail(false)}>← 返回事件列表</button>{selected ? <TraceDetail active={selected} bundle={bundle} problem={evidenceScope?.title} onSelect={id => focusEvidence(id, undefined, true)} onCopy={value => void copy(value)} /> : <div className="diag-empty-small">点击左侧事件即可查看对应操作的完整证据。无需滚动到表格底部。</div>}</aside>
    </div>}
    {view === 'status' && <section className="diag-status-page"><div className="diag-pane-intro"><strong>采集覆盖与最近记录</strong><p>这里只展示最后一次观察到的状态，不能代表组件当前在线，也不能证明另一台设备已完成同步。</p></div><div className="diag-observations">
      {observedStates.map(row => <div key={row.name} className="diag-observation"><div className="diag-observation-label">{row.name}</div><div className="diag-observation-value">{row.value}</div><div className="diag-observation-time">{row.at ? `记录于 ${stamp(row.at)}` : row.detail ?? '没有实时在线证据'}</div></div>)}
    </div><div className="diag-status-bottom"><div><h2>采集说明</h2><p>已收集 {events.length} 条事件，按账号保存 7 天；单个诊断存储最多 4,000 条 / 2 MiB。未能访问的组件不会被假设为正常。</p><p>构建信息：{bundle.environment.builds || '未知'}。导出不包含网页 URL、工作区名称或访问令牌。</p></div><div className="diag-status-actions"><button className="diag-secondary" onClick={() => void enableDetails().then(() => setMessage('已开启详细诊断，15 分钟后自动结束')).catch(() => setMessage('无法开启详细诊断'))}>开启 15 分钟详细诊断</button><button className="diag-secondary" onClick={() => void copy(bundle.summary)}>复制诊断摘要</button></div></div></section>}
  </main>;
}
