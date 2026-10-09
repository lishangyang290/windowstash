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
  return async (program, args, live = false) => {
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
      const result = await execute(program, args, live && verbose);
      if (visible) ui.success(label);
      return result;
    } catch (error) {
      if (visible) ui.error(`${label}未通过${verbose ? '' : '；使用 --verbose 可查看完整检查输出'}`);
      throw error;
    }
  };
}
