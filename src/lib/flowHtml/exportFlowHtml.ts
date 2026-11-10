import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { buildFlowData, renderFlowHtml, type FlowRuntimeAssets } from './buildFlowHtml';
import { buildFlowHar } from './buildFlowHar';

// Lado com efeito do "Export as HTML runner": lê o runtime (servido pelo
// próprio app a partir de public/runtime), monta o HTML e grava onde a
// pessoa escolher. A montagem em si é pura (buildFlowHtml); as escolhas
// (environments, segredos) vêm da janela de export (ExportFlowHtmlDialog).

let assetsCache: Promise<FlowRuntimeAssets> | null = null;

function loadAssets(): Promise<FlowRuntimeAssets> {
  if (!assetsCache) {
    const get = async (file: string) => {
      const res = await fetch(`/runtime/${file}`);
      if (!res.ok) throw new Error(`Could not read the runtime file ${file} (HTTP ${res.status}).`);
      return res.text();
    };
    assetsCache = Promise.all([get('pm-bootstrap.js'), get('moment.min.js'), get('flow-runner.js')])
      .then(([bootstrap, moment, runner]) => ({ bootstrap, moment, runner }))
      .catch(e => {
        assetsCache = null; // a próxima tentativa lê de novo
        throw e;
      });
  }
  return assetsCache;
}

function fileNameFor(name: string, extension: 'html' | 'har'): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'flow';
  return `${base}.${extension}`;
}

export interface ExportFlowHtmlOptions {
  /** `html`: página que roda o flow; `har`: HTTP Archive das requisições. */
  format: 'html' | 'har';
  path: string[];
  environments: { name: string; envMap: Record<string, string> }[];
  defaultEnvironment?: string;
  includeSecrets: boolean;
}

/** `saved: false` = a pessoa cancelou a escolha do arquivo. */
export async function exportFlowHtml(
  folder: CollectionItem,
  options: ExportFlowHtmlOptions
): Promise<{ saved: boolean; steps: number; environments: number; secrets: number; secretsIncluded: boolean }> {
  const flow = buildFlowData(folder, options);
  // HAR descreve UM environment: o que abriria selecionado no HTML.
  const content =
    options.format === 'har'
      ? JSON.stringify(buildFlowHar(flow), null, 2)
      : renderFlowHtml(flow, await loadAssets());
  const result = {
    steps: flow.steps.length,
    environments: options.format === 'har' ? 1 : flow.environments.length,
    secrets: flow.environments[0].variables.filter(v => v.secret).length,
    secretsIncluded: flow.includesSecrets,
  };

  const filePath = await save({
    defaultPath: fileNameFor(folder.name, options.format),
    filters: options.format === 'har'
      ? [{ name: 'HTTP Archive', extensions: ['har'] }]
      : [{ name: 'HTML', extensions: ['html'] }],
  });
  if (!filePath) return { saved: false, ...result };

  await writeTextFile(filePath, content);
  return { saved: true, ...result };
}
