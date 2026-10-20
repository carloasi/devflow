'use client';

import React, { useMemo, useRef } from 'react';
import { Trash2, ChevronRight, Info } from 'lucide-react';
import { DefaultHeaderState } from '@/lib/defaultHeaders';
import { QueryParam } from '@/app/types/QueryParam';
import { UrlInputWithVariables } from './Url-components/UrlInputWithVariables';

interface HeadersManagerProps {
  // Array controlado (não um Record<string,string>) — precisa preservar o
  // `enabled` de cada header pra desmarcar a flag não apagar a linha (ver
  // comentário em Tab.ts). O componente não guarda mais estado próprio: é
  // 100% controlado pelo pai, igual o ParamsTab.
  headersValue: QueryParam[];
  onChange: (headers: QueryParam[]) => void;
  // Headers automáticos (User-Agent, Accept...) — ver lib/defaultHeaders.ts.
  // Opcional: sem isso a seção não aparece.
  autoHeaders?: {
    states: DefaultHeaderState[];
    onToggle: (key: string, enabled: boolean) => void;
  };
}

const AUTO_STATUS_LABEL: Record<DefaultHeaderState['status'], string> = {
  sent: '',
  disabled: 'off',
  overridden: 'overridden',
  'no-body': 'only with body',
};

const AUTO_EXPANDED_KEY = 'devflow_auto_headers_expanded';

// Seção "Auto-generated headers": o que o app manda sozinho em toda request
// e que antes era invisível (só aparecia no snippet). Cada um pode ser
// desligado nesta request; um header da tabela com o mesmo nome o substitui.
function AutoHeadersSection({
  states,
  onToggle,
  gridStyle,
}: {
  states: DefaultHeaderState[];
  onToggle: (key: string, enabled: boolean) => void;
  gridStyle: React.CSSProperties;
}) {
  const [expanded, setExpanded] = React.useState(() => {
    try {
      return localStorage.getItem(AUTO_EXPANDED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const sentCount = states.filter(s => s.status === 'sent').length;

  const toggleExpanded = () => {
    setExpanded(prev => {
      try {
        localStorage.setItem(AUTO_EXPANDED_KEY, String(!prev));
      } catch {
        // Só não lembra a preferência.
      }
      return !prev;
    });
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={toggleExpanded}
        className="mb-1 flex cursor-pointer items-center gap-1.5 text-[12px] font-bold tracking-tight text-pm-text-muted hover:text-pm-text"
      >
        <ChevronRight size={13} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        Auto-generated headers
        <span className="rounded-full bg-pm-hover px-2 py-0.5 text-[10px] font-semibold">
          {sentCount} of {states.length} sent
        </span>
      </button>

      {expanded && (
        <>
          <p className="mb-2 flex items-start gap-1.5 text-[11px] text-pm-text-muted">
            <Info size={12} className="mt-[1px] shrink-0" />
            Sent automatically with every request. Uncheck to skip one here, or add a header with the same name
            above to replace it.
          </p>
          <div className="overflow-x-auto">
            <div className="min-w-full w-max border-l border-r border-t border-pm-border">
              {states.map(header => {
                const active = header.status === 'sent';
                const label = header.status === 'overridden'
                  ? `overridden by "${header.overriddenBy}"`
                  : AUTO_STATUS_LABEL[header.status];
                return (
                  <div
                    key={header.key}
                    className={`grid items-stretch border-b border-pm-border transition-colors hover:bg-pm-hover ${
                      active ? '' : 'opacity-50'
                    }`}
                    style={gridStyle}
                  >
                    <div className="flex h-full items-center justify-center border-r border-pm-border py-1">
                      <input
                        type="checkbox"
                        // "overridden" e "only with body" não dependem da
                        // caixa: ela mostra só se o padrão está ligado.
                        checked={header.status !== 'disabled'}
                        disabled={header.status === 'overridden'}
                        onChange={e => onToggle(header.key, e.target.checked)}
                        title={header.status === 'overridden' ? 'Replaced by a header above' : undefined}
                        className="h-3.5 w-3.5 cursor-pointer rounded-[4px] border border-pm-border bg-transparent accent-pm-accent disabled:cursor-default disabled:opacity-30"
                      />
                    </div>
                    <div className="flex h-full items-center overflow-hidden border-r border-pm-border bg-pm-hover/40 px-2 py-1 font-mono text-[12px] text-pm-text">
                      <span className={`truncate ${header.status === 'overridden' ? 'line-through' : ''}`}>{header.key}</span>
                    </div>
                    <div className="flex h-full items-center gap-2 overflow-hidden border-r border-pm-border px-2 py-1 font-mono text-[12px] text-pm-text-muted">
                      <span className={`truncate ${header.status === 'overridden' ? 'line-through' : ''}`}>{header.value}</span>
                    </div>
                    <div className="flex h-full items-center px-2">
                      {label && (
                        <span className="whitespace-nowrap rounded bg-pm-hover px-1.5 py-0.5 font-sans text-[10px] text-pm-text-muted">
                          {label}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export const HeadersManager: React.FC<HeadersManagerProps> = ({ headersValue, onChange, autoHeaders }) => {
  const [keyWidth, setKeyWidth] = React.useState(220);
  const [valueWidth, setValueWidth] = React.useState(260);

  // Mesmo fix aplicado no ParamsTab.tsx: a linha vazia (placeholder) usa um
  // id ESTÁVEL guardado numa ref, não um id fixo compartilhado. Ao promover
  // essa linha pro array real (1º caractere digitado), ela LEVA esse mesmo
  // id — só a PRÓXIMA linha vazia (ainda não focada) recebe um id novo. Sem
  // isso, o React reconciliava por key errado e o campo "pulava de linha" /
  // perdia o texto digitado a cada tecla (ver ParamsTab.tsx pro histórico
  // completo do bug).
  const placeholderIdRef = useRef<string>(crypto.randomUUID());

  const displayHeaders = useMemo(() => {
    const params = [...(headersValue || [])];
    const last = params[params.length - 1];
    const needsEmptyRow = !last || last.key !== '' || last.value !== '';

    if (needsEmptyRow) {
      params.push({
        id: placeholderIdRef.current,
        key: '',
        value: '',
        enabled: false,
      });
    }

    return params;
  }, [headersValue]);

  const handleHeaderChange = (id: string, field: keyof QueryParam, value: any) => {
    if (id === placeholderIdRef.current) {
      const newHeader: QueryParam = {
        // Mesmo id que a linha tinha como placeholder — preserva a
        // identidade do input focado (ver comentário acima).
        id: placeholderIdRef.current,
        key: field === 'key' ? value : '',
        value: field === 'value' ? value : '',
        enabled: true,
      };

      // A PRÓXIMA linha vazia (nunca focada ainda) recebe um id novo.
      placeholderIdRef.current = crypto.randomUUID();

      onChange([...headersValue, newHeader]);
      return;
    }

    onChange(
      headersValue.map((header) => (header.id !== id ? header : { ...header, [field]: value }))
    );
  };

  const removeHeader = (id: string) => {
    onChange(headersValue.filter((h) => h.id !== id));
  };

  const startResize = (e: React.MouseEvent, column: 'key' | 'value') => {
    e.preventDefault();
    const startX = e.clientX;
    const initialWidth = column === 'key' ? keyWidth : valueWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.max(80, initialWidth + delta);

      if (column === 'key') {
        setKeyWidth(nextWidth);
      } else {
        setValueWidth(nextWidth);
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const gridStyle = {
    gridTemplateColumns: `36px ${keyWidth}px ${valueWidth}px 36px`,
  };

  const enabledCount = headersValue.filter((h) => h.enabled && h.key.trim() !== '').length;

  return (
    <div className="mb-6 select-none p-4">
      {/* TÍTULO DA SEÇÃO */}
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-bold tracking-tight text-pm-text-muted">
          Headers
        </span>
        {enabledCount > 0 && (
          <span className="rounded-full bg-pm-hover px-2 py-0.5 text-[10px] font-semibold text-pm-text-muted">
            {enabledCount} ativo{enabledCount > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* TABELA CONTAINER */}
      <div className="overflow-x-auto">
        <div className="min-w-full w-max border-l border-r border-pm-border">

          {/* HEADER DA TABELA */}
          <div className="grid items-stretch border-t border-b border-pm-border" style={gridStyle}>
            <div className="h-full self-stretch border-r border-pm-border" />

            <div className="group relative flex h-full items-center border-r border-pm-border bg-pm-hover/40 px-2 py-1 text-[11px] font-medium text-pm-text-muted">
              Key
              <div
                onMouseDown={(e) => startResize(e, 'key')}
                className="absolute -right-[3px] top-0 bottom-0 z-20 w-[5px] cursor-col-resize"
              >
                <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-pm-border" />
              </div>
            </div>

            <div className="group relative flex h-full items-center border-r border-pm-border px-2 py-1 text-[11px] font-medium text-pm-text-muted">
              Value
              <div
                onMouseDown={(e) => startResize(e, 'value')}
                className="absolute -right-[3px] top-0 bottom-0 z-20 w-[5px] cursor-col-resize"
              >
                <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-pm-border" />
              </div>
            </div>

            <div />
          </div>

          {/* LINHAS DA TABELA (ROWS) */}
          {displayHeaders.map((header, index) => {
            const isPlaceholder = header.id === placeholderIdRef.current;
            const isDisabledRow = !header.enabled && !isPlaceholder;

            return (
              <div
                key={header.id || `${header.key}-${index}`}
                className={`group grid items-stretch border-b border-pm-border transition-colors hover:bg-pm-hover ${
                  isDisabledRow ? 'opacity-45' : ''
                }`}
                style={gridStyle}
              >
                {/* CHECKBOX */}
                <div className="flex h-full items-center justify-center border-r border-pm-border py-1">
                  <input
                    type="checkbox"
                    checked={header.enabled}
                    disabled={isPlaceholder}
                    onChange={(e) => handleHeaderChange(header.id, 'enabled', e.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer rounded-[4px] border border-pm-border bg-transparent accent-pm-accent disabled:cursor-default disabled:opacity-20"
                  />
                </div>

                {/* COLUNA KEY */}
                <div className="flex h-full items-center overflow-hidden border-r border-pm-border bg-pm-hover/40 focus-within:bg-pm-accent/[0.06]">
                  <input
                    value={header.key}
                    placeholder="key"
                    onChange={(e) => handleHeaderChange(header.id, 'key', e.target.value)}
                    className="h-full w-full truncate bg-transparent px-2 py-1 font-mono text-[12px] text-pm-text outline-none placeholder-pm-text-muted"
                  />
                </div>

                {/* COLUNA VALUE */}
                <div className="flex h-full items-center overflow-hidden border-r border-pm-border pl-2 focus-within:bg-pm-accent/[0.06]">
                  <UrlInputWithVariables
                    value={header.value}
                    onChange={(value) => handleHeaderChange(header.id, 'value', value)}
                    placeholder="value"
                    className="h-full w-full border-0 bg-transparent font-mono text-[12px] text-pm-text outline-none placeholder-pm-text-muted"
                  />
                </div>

                {/* AÇÃO DE EXCLUSÃO */}
                <div className="flex h-full items-center justify-center">
                  <button
                    disabled={isPlaceholder}
                    onClick={() => removeHeader(header.id)}
                    className={`cursor-pointer rounded p-1.5 text-pm-text-muted transition-all hover:bg-red-500/10 hover:text-red-400 ${
                      isPlaceholder ? 'pointer-events-none opacity-0' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {autoHeaders && (
        <AutoHeadersSection
          states={autoHeaders.states}
          onToggle={autoHeaders.onToggle}
          // Última coluna mais larga: guarda o rótulo do estado.
          gridStyle={{ gridTemplateColumns: `36px ${keyWidth}px ${valueWidth}px minmax(36px, max-content)` }}
        />
      )}
    </div>
  );
};
