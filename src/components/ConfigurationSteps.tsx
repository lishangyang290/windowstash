import React from 'react';

export function ConfigurationSteps({ step, completed, busy = false, quick = false, canLogin = step === 3, onSelect }: {
  step: number; completed: number; busy?: boolean; quick?: boolean; canLogin?: boolean; onSelect: (step: number) => void;
}) {
  const steps = ['创建项目', '初始化数据库', '连接 Supabase', '注册 / 登录'];
  const stepIcons = [
    <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 11v6m-3-3h6" /></>,
    <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>,
    <><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.15 1.15" /><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" /></>,
    <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
  ];
  return (
        <nav className="config-steps" aria-label="配置步骤">
          {steps.map((title, index) => (!quick || index >= 2) && <React.Fragment key={title}>
            {index > (quick ? 2 : 0) ? <span className="config-step-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg></span> : null}
            <button disabled={(index === 3 && !canLogin) || busy} data-state={index === step ? 'current' : index < completed ? 'complete' : 'upcoming'} title={index === 3 && !canLogin ? '验证并保存连接后继续' : undefined} aria-current={step === index ? 'step' : undefined} onClick={() => onSelect(index)}>
              <span className="config-step-icon" aria-hidden="true"><svg viewBox="0 0 24 24">{stepIcons[index]}</svg></span>
              <span className="config-step-label">{title}</span>
              {index < completed ? <span className="sr-only">已完成</span> : null}
            </button>
          </React.Fragment>)}
        </nav>
  );
}
