// Small, line-based presentation layer; redirected output stays plain text.
export function terminalUI(output = process.stdout, log = (text) => console.log(text)) {
  const color = Boolean(output.isTTY && process.env.TERM !== 'dumb' && !('NO_COLOR' in process.env));
  const style = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = (text) => style('2', text);
  const bold = (text) => style('1', text);
  return {
    dim, bold,
    section(title) { log(`\n${dim('─'.repeat(48))}\n\n${bold(title)}\n`); },
    field(label, value) { log(`  ${label}  ${value}`); },
    list(items) { log(items.map((item) => `  ${item}`).join('\n')); },
    hint(text) { log(`\n  ${dim(text)}\n`); },
    pending(text) { log(`  ${bold('进行中')}  ${text}`); },
    success(text) { log(`  ${style('32', '通过')}    ${text}`); },
    warning(text) { log(`\n  ${style('33', '提示')}    ${text}\n`); },
    error(text) { log(`\n  ${style('31', '失败')}    ${text}\n`); },
    prompt(text) { return `\n  ${dim(text)}\n\n  ${bold('›')} `; },
    paste(text) { return `\n  ${bold(text)}\n\n  ${dim('可粘贴多行，空行不会结束输入。')}\n  ${dim('结束：另起一行输入 :end 并回车')}\n  ${dim('取消：另起一行输入 :cancel 并回车')}\n\n`; },
  };
}

export function presentedCommand(execute, ui, verbose = false) {
  return async (program, args, live = false, timeout) => {
    const companion = args.includes('companion');
    const script = args[args.indexOf('run') + 1];
    const gitStep = program === 'git' && (args[0] === 'add' ? '暂存本次版本文件'
      : args[0] === 'commit' ? '创建版本提交'
      : args[0] === 'push' ? args.at(-1)?.includes('refs/tags/') ? '推送发布 Tag' : '推送 main'
      : args[0] === 'tag' && args[1] !== '--list' ? '创建发布 Tag' : '');
    const visible = live || Boolean(gitStep);
    const label = gitStep || (program === 'npm' ? `${companion ? 'Companion' : 'Extension'} · ${script}`
      : args.includes('--test') ? '发布工具测试'
      : args[0]?.endsWith('validate-release-version.mjs') ? '九处版本一致性'
      : args.includes('--stat') ? '变更摘要' : 'Git 空白检查');
    if (verbose) ui.hint(`检查 / 执行：${program} ${args.join(' ')}`);
    if (visible) ui.pending(label);
    try {
      const result = await execute(program, args, live && verbose, timeout);
      if (visible) ui.success(label);
      return result;
    } catch (error) {
      if (visible) ui.error(`${label}未通过${verbose ? '' : '；使用 --verbose 可查看完整检查输出'}`);
      throw error;
    }
  };
}

export function workflowProgress(workflow) {
  const taskName = (name) => ({
    'Validate Extension': 'Extension 检查与构建',
    'Validate Companion frontend': 'Companion 前端检查与构建',
    'Build Companion app': 'Companion 应用构建',
    'Assemble macOS package': 'ZIP 打包',
    'Scan and validate final ZIP': 'ZIP 检查',
    'Create GitHub Release and upload macOS asset': '上传 Release 和 ZIP 附件',
  })[name] ?? name;
  const jobs = workflow?.jobs ?? [];
  const steps = jobs.flatMap((job) => job.steps ?? []);
  const completed = steps.filter((step) => step.status === 'completed');
  const failed = completed.filter((step) => !['success', 'skipped'].includes(step.conclusion));
  const current = jobs.flatMap((job) => {
    const running = (job.steps ?? []).filter((step) => step.status === 'in_progress');
    return running.length ? running.map((step) => `${job.name} · ${taskName(step.name)}`)
      : job.status === 'in_progress' ? [`${job.name} · 等待步骤状态`] : [];
  });
  const status = workflow?.status ?? 'waiting';
  const labels = { waiting: '等待 Workflow', queued: '排队中', pending: '等待中', waiting_for_review: '等待审核', in_progress: '构建中', completed: '已结束' };
  return [
    `Actions  ${labels[status] ?? status}${workflow?.conclusion ? ` · ${workflow.conclusion}` : ''}`,
    steps.length ? `步骤  已结束 ${completed.length}/${steps.length}（成功 ${completed.filter((step) => step.conclusion === 'success').length}，跳过 ${completed.filter((step) => step.conclusion === 'skipped').length}，未成功 ${failed.length}）` : '步骤  尚未获取，进度未知',
    `任务  ${current.join('；') || (failed.length ? failed.map((step) => `${taskName(step.name)} · ${step.conclusion ?? '未知'}`).join('；') : status === 'completed' ? workflow.conclusion === 'success' ? '检查 Release 和 ZIP 附件' : '查看 Workflow 及 Job 日志' : '等待 GitHub 更新任务状态')}`,
  ];
}

export function liveProgress(output = process.stdout, log = (text) => console.log(text), allowRefresh = true) {
  const refresh = Boolean(allowRefresh && output.isTTY && output.write && process.env.TERM !== 'dumb' && !('NO_COLOR' in process.env));
  let drawn = false;
  // Keep each row within the terminal width so cursor movement cannot erase other output.
  const fit = (text) => {
    let width = 0, result = '';
    for (const char of text.replace(/[\p{Cc}\p{Cf}]/gu, ' ')) {
      width += char.codePointAt(0) > 255 ? 2 : 1;
      if (width > (output.columns || 80) - 2) return result + '…';
      result += char;
    }
    return result;
  };
  return {
    update(lines, elapsed, tick = false) {
      if (!refresh && tick) return;
      const seconds = Math.floor(elapsed / 1000);
      const rows = [...lines, `等待  ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒 · 每 12 秒查询 · Ctrl+C 结束等待`];
      if (refresh) {
        output.write((drawn ? '\x1b[4A' : '') + rows.map((row) => `\r\x1b[2K${fit('  ' + row)}\n`).join(''));
        drawn = true;
      } else log(rows.map((row) => '  ' + row).join('\n'));
    },
  };
}
