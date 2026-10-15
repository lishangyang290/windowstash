import React, { useMemo, useState } from 'react';
import { differentDevice, eventNames, importBundle, makeBundle, type DiagnosticBundle, type DiagnosticEvent } from './diagnostics';
import './diagnostics.css';

const labels: Record<string, string> = { extension: 'Chrome 扩展', companion: 'Companion', 'native-host': 'Native Host', 'companion-rust': 'Companion Rust', started: '开始', success: '完成', waiting: '等待', failed: '失败', cancelled: '已取消', observed: '已观察', confirmed: '已证实的异常', suspected: '有证据支持的怀疑', insufficient: '证据不足，无法判断' };
const stamp = (at?: string | null) => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '未知';
const category = (e: DiagnosticEvent) => e.state.action === 'remove' || e.state.action === 'delete' || e.event === 'local.deleted' ? '删除' : e.state.action === 'update' ? '修改' : ['save', 'save-close', 'put'].includes(String(e.state.action)) ? '保存' : e.event.startsWith('realtime.') || e.event.startsWith('lifecycle.') ? '连接' : '同步';
function download(bundle: DiagnosticBundle) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `windowstash-diagnostics-${bundle.exportedAt.replace(/[:.]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
export function DiagnosticCenter({ load, enableDetails, save }: { load: () => Promise<DiagnosticBundle>; enableDetails: () => Promise<void>; save?: (bundle: DiagnosticBundle) => Promise<string> }) {
  const [bundle, setBundle] = useState<DiagnosticBundle>(() => makeBundle([]));
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [query, setQuery] = useState(''), [level, setLevel] = useState(''), [component, setComponent] = useState(''), [kind, setKind] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [page, setPage] = useState(0);
  const accountRevision = React.useRef(0);
  const importedEvents = React.useRef<DiagnosticEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    setBusy(true);
    const revision = accountRevision.current;
    try { const latest = await load(); if (revision !== accountRevision.current) return; setBundle(makeBundle([...latest.events, ...importedEvents.current], latest.coverage)); setMessage(''); setPage(0); }
    catch { setMessage('无法读取部分诊断记录；未修改工作区。请检查组件授权或重试。'); }
    finally { setBusy(false); }
  }, [load]);
  React.useEffect(() => { document.title = '诊断中心 · WindowStash'; void refresh(); }, [refresh]);
  React.useEffect(() => {
    const clear = () => { accountRevision.current++; importedEvents.current = []; setBundle(makeBundle([])); setSelected(null); setMessage('账号已变化，已隐藏诊断记录；请重新刷新。'); };
    window.addEventListener('windowstash-diagnostic-account-changed', clear);
    return () => window.removeEventListener('windowstash-diagnostic-account-changed', clear);
  }, []);
  const events = bundle.events;
  const filtered = useMemo(() => [...events].reverse().filter(e => (!level || e.level === level) && (!component || e.component === component) && (!kind || category(e) === kind)
    && (!from || Date.parse(e.timestamp) >= new Date(from).getTime()) && (!to || Date.parse(e.timestamp) <= new Date(to).getTime())
    && (!query || [eventNames[e.event] ?? '诊断事件', e.event, e.operationId, e.workspaceRef, e.source, e.errorCode].join(' ').toLowerCase().includes(query.toLowerCase()))), [events, query, level, component, kind, from, to]);
  const active = events.find(e => e.id === selected);
  const traceEvents = useMemo(() => {
    if (!active) return [];
    const related = new Set(events.filter(e => e.operationId === active.operationId && e.deviceId === active.deviceId).map(e => e.id));
    // Follow only explicit graph edges, never a time-proximity heuristic.
    const adjacency = new Map<string, string[]>();
    for (const { from, to } of bundle.links) { adjacency.set(from, [...(adjacency.get(from) ?? []), to]); adjacency.set(to, [...(adjacency.get(to) ?? []), from]); }
    const pending = [...related];
    for (let i = 0; i < pending.length; i++) for (const id of adjacency.get(pending[i]!) ?? []) if (!related.has(id)) { related.add(id); pending.push(id); }
    return events.filter(e => related.has(e.id));
  }, [active, events, bundle.links]);
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); setMessage('已复制'); } catch { setMessage('剪贴板不可用；可以通过导出文件获取这些字段。'); } }
  const last = (event: string) => events.filter(e => e.event === event).at(-1);
  const lastUpload = events.filter(e => e.event === 'cloud.version' || e.event === 'cloud.done' && ['put', 'remove'].includes(String(e.state.action))).at(-1);
  const realtime = last('realtime.status');
  const queue = last('queue.snapshot');
  const lastFailure = events.filter(e => e.result === 'failed').at(-1);
  const overview = [
    ['设备与平台', bundle.environment.platforms || '未知'],
    ['Chrome 扩展', bundle.coverage.extension ?? '未知'], ['Native Host', bundle.coverage['native-host'] ?? '未知'], ['Companion', bundle.coverage.companion ?? '未知'],
    ['Supabase', last('cloud.done') ? `最近请求确认 ${stamp(last('cloud.done')?.timestamp)}` : '未知；没有成功请求证据'],
    ['Realtime 订阅', realtime ? `最近记录 ${String(realtime.state.status)} · ${stamp(realtime.timestamp)}` : '未知；没有订阅记录'],
    ['最近成功上传', stamp(lastUpload?.timestamp)], ['最近实际接收', stamp(last('realtime.event')?.timestamp)],
    ['等待同步任务', queue ? `最近快照：${Number(queue.state.pending ?? 0) + Number(queue.state.deleted ?? 0)} · ${stamp(queue.timestamp)}` : '未知'],
    ['最近同步异常', lastFailure ? `${eventNames[lastFailure.event] ?? '操作异常'} · ${stamp(lastFailure.timestamp)}` : '保留范围内未记录到'],
  ];
  return <main className="diagnostics">
    <header><div><a className="diagnostic-brand" href="#" onClick={e => e.preventDefault()}>WindowStash</a><h1>诊断中心</h1><p>收集故障证据，追踪同步过程。所有数据仅保存在本机。</p></div><div className="diagnostic-actions"><button disabled={busy} onClick={() => void refresh()}>刷新记录</button><label className="diagnostic-file">导入诊断文件<input type="file" accept=".json,application/json" onChange={e => { const revision = accountRevision.current; const file = e.target.files?.[0]; if (!file) return; if (file.size > 20 * 1024 * 1024) { setMessage('诊断文件超过 20 MiB'); return; } void file.text().then(raw => { if (revision !== accountRevision.current) return; const imported = importBundle(raw); importedEvents.current = [...new Map([...importedEvents.current, ...imported.events].map(event => [event.id, event])).values()].slice(-20000); setBundle(previous => makeBundle([...previous.events, ...imported.events], { ...previous.coverage, imported: '已合并导入文件；跨设备时间差包含未知时钟偏差' })); setMessage('已离线合并；使用精确云端版本关联事件'); }).catch(() => setMessage('无法导入：文件格式无效或超出容量限制')); e.target.value = ''; }} /></label><button className="diagnostic-primary" disabled={busy} onClick={() => { setBusy(true); const revision = accountRevision.current; void load().then(latest => { if (revision !== accountRevision.current) throw new Error('account changed'); const safe = makeBundle([...latest.events, ...importedEvents.current], latest.coverage); setBundle(safe); return save ? save(safe).then(path => setMessage(`已导出：${path}`)) : download(safe); }).catch(() => setMessage('导出失败，诊断记录仍保留在本机')).finally(() => setBusy(false)); }}>导出诊断日志</button></div></header>
    {message && <p role="status" className="diagnostic-message">{message}</p>}
    <nav aria-label="诊断视图">{[['overview', '运行状态'], ['events', '事件与追踪'], ['findings', `故障分析 ${bundle.findings.length}`]].map(([id, name]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id!)}>{name}</button>)}</nav>
    {tab === 'overview' && <><section><h2>运行状态概览</h2><p>状态来自实际事件，显示观察时间。历史连接记录不代表当前在线，也不代表另一设备同步完成。</p><dl className="diagnostic-overview">{overview.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></section><section><h2>诊断记录</h2><p>当前范围：{stamp(bundle.range.from)} — {stamp(bundle.range.to)}，共 {events.length} 条记录。</p><p>自动保留最近 7 天，每个存储最多 4,000 条 / 2 MiB；Native Host 与 Companion 共用有界文件。组件缺失及日志丢失会限制结论。</p><button onClick={() => void enableDetails().then(() => setMessage('详细诊断已开启，15 分钟后自动恢复；无需重启')).catch(() => setMessage('详细诊断开启失败'))}>开启 15 分钟详细诊断</button><button onClick={() => void copy(bundle.summary)}>复制可读摘要</button><p>构建：{bundle.environment.builds || '未知'}。导出不会包含工作区名称、标签页内容或身份凭据。</p></section></>}
    {tab === 'findings' && <section><h2>基于证据的故障分析</h2><p>分析不调用 AI 服务。未记录到事件不等于事件未发生；云端版本关联也不能证明界面已刷新。</p>{!bundle.findings.length && <p>保留范围内尚无足够证据形成异常结论。不能据此证明同步正常。</p>}{bundle.findings.map((f, i) => <article className="diagnostic-finding" key={i}><small>{labels[f.confidence]}</small><h3>{f.symptom}</h3><p>{f.hypothesis}</p><p>{f.check}</p><p>设备 / 组件：{f.components.map(c => labels[c] ?? c).join('、')} · {f.devices.map(d => d.slice(0, 8)).join('、')}</p><p>最后成功步骤：{eventNames[events.find(e => e.id === f.lastSuccess)?.event ?? ''] ?? '未记录到'}；首个异常证据：{eventNames[events.find(e => e.id === f.firstAbnormal)?.event ?? ''] ?? '未记录到'}</p><p>证据缺口：{f.missing.join('；') || '深层根因仍需源码核验'}</p><button onClick={() => { setSelected(f.firstAbnormal ?? f.evidence[0] ?? null); setTab('events'); }}>查看关联证据</button><button onClick={() => void copy(JSON.stringify(f, null, 2))}>复制诊断结论</button></article>)}</section>}
    {tab === 'events' && <section><h2>事件日志</h2><div className="diagnostic-filters"><input aria-label="搜索诊断记录" placeholder="搜索事件、操作 ID、工作区关联标识或源码模块" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} /><select aria-label="日志级别" value={level} onChange={e => { setLevel(e.target.value); setPage(0); }}><option value="">所有级别</option>{['INFO','WARN','ERROR'].map(x => <option key={x}>{x}</option>)}</select><select aria-label="来源组件" value={component} onChange={e => { setComponent(e.target.value); setPage(0); }}><option value="">所有组件</option>{['extension','companion','native-host','companion-rust'].map(x => <option key={x} value={x}>{labels[x]}</option>)}</select><select aria-label="事件分类" value={kind} onChange={e => { setKind(e.target.value); setPage(0); }}><option value="">所有分类</option>{['保存','修改','删除','连接','同步'].map(x => <option key={x}>{x}</option>)}</select><label>起始时间<input type="datetime-local" value={from} onChange={e => { setFrom(e.target.value); setPage(0); }} /></label><label>结束时间<input type="datetime-local" value={to} onChange={e => { setTo(e.target.value); setPage(0); }} /></label></div>
      <div className="diagnostic-table"><table><thead><tr><th>时间</th><th>来源组件</th><th>事件</th><th>结果</th><th>耗时</th></tr></thead><tbody>{filtered.slice(page * 100, (page + 1) * 100).map(e => <tr key={e.id}><td>{stamp(e.timestamp)}</td><td>{labels[e.component]}</td><td><button className="diagnostic-event" onClick={() => setSelected(e.id)}>{eventNames[e.event] ?? '诊断事件'}</button></td><td data-result={e.result}>{labels[e.result]}</td><td>{e.durationMs === undefined ? '未记录' : `${e.durationMs} ms`}</td></tr>)}</tbody></table></div>{!filtered.length && <p>当前筛选下未记录到事件。</p>}<div className="diagnostic-pagination"><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(filtered.length / 100))} · {filtered.length} 条</span><button disabled={(page + 1) * 100 >= filtered.length} onClick={() => setPage(p => p + 1)}>下一页</button></div>
      {active && <aside className="diagnostic-trace"><h2>操作追踪详情</h2><p>操作 ID：<code>{active.operationId}</code></p><p>仅合并明确父事件或工作区与精确云端版本相同的记录。两设备时间差包含未知的时钟偏差。</p><ol>{traceEvents.map(e => <li key={e.id}><span>{stamp(e.timestamp)} · {labels[e.component]}</span><strong>{eventNames[e.event] ?? '诊断事件'}</strong><small>{labels[e.result]} · {e.durationMs === undefined ? '耗时未记录' : `${e.durationMs} ms`}</small><details><summary>技术字段</summary><button onClick={() => void copy(JSON.stringify(e, null, 2))}>复制字段</button><pre>{JSON.stringify(e, null, 2)}</pre></details></li>)}</ol><h3>阶段证据核对</h3><ul>{[['本地保存 / 删除', ['local.persisted','local.deleted']], ['Native Host 持久化', ['native.persisted','native.publish.persisted']], ['云端任务排队', ['queue.upload','queue.delete']], ['Supabase 请求开始', ['cloud.start']], ['云端确认', ['cloud.version','cloud.done']], ['另一设备 Realtime 接收', ['realtime.event']], ['本机校准完成', ['native.applied']], ['Companion 界面提交', ['ui.committed']]].map(([name, stages]) => <li key={String(name)}>{name}：{traceEvents.some(e => (stages as string[]).includes(e.event) && (name !== '另一设备 Realtime 接收' || differentDevice(active, e))) ? '存在记录，见上述设备与结果' : '未记录到 / 待确认'}</li>)}</ul><button onClick={() => setSelected(null)}>收起追踪</button></aside>}
    </section>}
  </main>;
}
