'use client';

import { useEffect, useMemo, useRef } from 'react';
import { EXTENSION_API_SCRIPT, UseExtensionHostResult } from './useExtensionHost';

interface ExtensionSlotProps {
  host: UseExtensionHostResult;
  slot: 'statusBar';
}

// Variáveis de tema repassadas pro iframe: sem isso a extensão não teria
// como acompanhar o tema escolhido no app (ela não enxerga o CSS de fora).
const THEME_VARS = [
  '--color-pm-bg',
  '--color-pm-surface',
  '--color-pm-sidebar',
  '--color-pm-hover',
  '--color-pm-row-active',
  '--color-pm-border',
  '--color-pm-text',
  '--color-pm-text-secondary',
  '--color-pm-text-muted',
  '--color-pm-accent',
];

function readThemeVars(): string {
  if (typeof document === 'undefined') return '';
  const styles = getComputedStyle(document.documentElement);
  return THEME_VARS.map(name => `${name}: ${styles.getPropertyValue(name).trim()};`).join(' ');
}

export function ExtensionSlot({ host, slot }: ExtensionSlotProps) {
  const themeCss = useMemo(readThemeVars, []);

  const items = host.extensions.filter(extension => {
    if (extension.error) return false;
    if (host.disabledIds.includes(extension.id)) return false;
    if (slot === 'statusBar') return (extension.contributes?.statusBarItems?.length ?? 0) > 0;
    return false;
  });

  if (items.length === 0) return null;

  return (
    <>
      {items.map(extension => (
        <ExtensionFrame
          key={`${extension.id}:${extension.path}`}
          host={host}
          id={extension.id}
          name={extension.name}
          html={extension.html}
          themeCss={themeCss}
        />
      ))}
    </>
  );
}

interface ExtensionFrameProps {
  host: UseExtensionHostResult;
  id: string;
  name: string;
  html: string;
  themeCss: string;
}

function ExtensionFrame({ host, id, name, html, themeCss }: ExtensionFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const size = host.frameSizes[id] ?? { width: 140, height: 22, expanded: false, collapsedWidth: 140 };
  // Expandido o iframe vira overlay, então o espaço reservado na barra de
  // status continua sendo o do widget colapsado — senão abriria um buraco do
  // tamanho do painel toda vez que a extensão abrisse.
  const slotWidth = size.expanded ? size.collapsedWidth : size.width;

  // A API é injetada antes do conteúdo da extensão — assim `devflow` já
  // existe quando os scripts dela rodam, e ela não precisa importar nada.
  const srcDoc = useMemo(
    () => `<style>:root { ${themeCss} }</style>${EXTENSION_API_SCRIPT}${html}`,
    [themeCss, html]
  );

  useEffect(() => {
    host.registerFrame(id, ref.current?.contentWindow ?? null);
  }, [host, id, srcDoc]);

  return (
    <div className="relative flex h-full items-center" style={{ width: slotWidth }}>
      <iframe
        ref={ref}
        title={name}
        // allow-scripts sem allow-same-origin: a extensão roda em origem
        // opaca, sem acesso a storage/cookies do app.
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={() => host.registerFrame(id, ref.current?.contentWindow ?? null)}
        style={
          size.expanded
            ? {
                // Expandido vira overlay ancorado subindo a partir da barra
                // — um popover não caberia nos 22px do widget.
                position: 'absolute',
                bottom: 0,
                right: 0,
                width: size.width,
                height: size.height,
                zIndex: 10060,
              }
            : { width: size.width, height: size.height }
        }
        className={
          size.expanded
            ? 'rounded-lg border border-pm-border bg-pm-surface shadow-2xl'
            : 'border-0 bg-transparent'
        }
      />
    </div>
  );
}
