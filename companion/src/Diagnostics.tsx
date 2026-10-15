import React from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { DiagnosticBundle } from '../../shared/diagnostics';
import { DiagnosticCenter } from '../../shared/DiagnosticCenter';
import { companionDiagnostics, detailedDiagnostics } from './lib/diagnostics';
const save = (bundle: DiagnosticBundle) => invoke<string>('export_diagnostics', { bundle });
export default function Diagnostics() {
  React.useEffect(() => { const unlisten = listen('diagnostic-account-changed', () => window.dispatchEvent(new Event('windowstash-diagnostic-account-changed'))); return () => { void unlisten.then(stop => stop()); }; }, []);
  return <DiagnosticCenter load={companionDiagnostics} enableDetails={detailedDiagnostics} save={save} />; }
