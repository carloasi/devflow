'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, CircleCheck, CircleX, Radio } from 'lucide-react';
import { GrpcStreamEvent, GrpcStreamState } from '@/app/types/Grpc';

// Linha do tempo de um stream gRPC: o que foi enviado (↑), o que chegou (↓),
// a metadata e o status final, na ordem em que aconteceu.

function preview(json: string | null): string {
  if (!json) return '';
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}

function EventRow({ event, index }: { event: GrpcStreamEvent; index: number }) {
  const [open, setOpen] = useState(false);
  const isMessage = event.kind === 'sent' || event.kind === 'message';

  if (!isMessage) {
    const ok = event.kind === 'end';
    const isHeaders = event.kind === 'headers';
    return (
      <div
        className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-[11px] ${
          isHeaders ? 'text-pm-text-muted' : ok ? 'bg-[#0f3d2a]/40 text-[#4ff09d]' : 'bg-[#3d1a1a]/40 text-[#ff7b7b]'
        }`}
      >
        <span className="w-14 shrink-0 text-right font-mono tabular-nums text-pm-text-muted">+{event.elapsedMs} ms</span>
        {isHeaders ? (
          <span>
            Stream opened{event.metadata.length ? ` — ${event.metadata.length} header(s)` : ''}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1 font-semibold">
              {ok ? <CircleCheck size={12} /> : <CircleX size={12} />}
              {event.statusCode} {event.statusName}
              {ok ? ' — stream finished' : ''}
            </span>
            {event.statusMessage && (
              <span className="whitespace-pre-wrap break-words font-mono text-[10.5px] opacity-90">{event.statusMessage}</span>
            )}
          </span>
        )}
      </div>
    );
  }

  const sent = event.kind === 'sent';
  return (
    <div className="rounded-md border border-pm-border/50 bg-pm-bg/30">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-pm-hover/50"
      >
        <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-pm-text-muted">
          +{event.elapsedMs} ms
        </span>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
            sent ? 'bg-sky-500/15 text-sky-300' : 'bg-emerald-500/15 text-emerald-300'
          }`}
          title={sent ? 'Sent' : 'Received'}
        >
          {sent ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-pm-text-muted">#{index}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-pm-text-secondary">
          {preview(event.message)}
        </span>
        <ChevronRight size={12} className={`shrink-0 text-pm-text-muted transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <pre className="max-h-[320px] overflow-auto border-t border-pm-border/50 px-3 py-2 font-mono text-[11px] text-pm-text">
          {event.message}
        </pre>
      )}
    </div>
  );
}

interface Props {
  stream: GrpcStreamState;
  tab: 'response' | 'metadata';
}

export function GrpcStreamTimeline({ stream, tab }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  // Segue as mensagens novas, a menos que o usuário tenha rolado pra cima
  // pra ler alguma — aí não puxa a tela de volta.
  const followRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [stream.events.length]);

  // Número de cada mensagem dentro da sua direção (#1, #2... enviadas e
  // recebidas contadas separadas).
  const numbered = useMemo(() => {
    let sent = 0;
    let received = 0;
    return stream.events.map(event => ({
      event,
      index: event.kind === 'sent' ? ++sent : event.kind === 'message' ? ++received : 0,
    }));
  }, [stream.events]);

  if (tab === 'metadata') {
    const headers = stream.events.find(e => e.kind === 'headers')?.metadata ?? [];
    const final = stream.events.find(e => e.kind === 'end' || e.kind === 'error');
    const trailers = final?.metadata ?? [];
    const section = (title: string, rows: [string, string][]) => (
      <div className="mb-3">
        <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-pm-text-muted">{title}</div>
        {rows.length === 0 ? (
          <div className="px-2 text-[11px] text-pm-text-muted">None</div>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px]">
            <tbody>
              {rows.map(([key, value], i) => (
                <tr key={`${key}-${i}`} className="border-b border-pm-border/70">
                  <td className="w-2/5 px-4 py-1.5 align-top font-semibold text-pm-text-muted">{key}</td>
                  <td className="break-all px-4 py-1.5 text-[#4ff09d]">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
    return (
      <div className="h-full overflow-y-auto py-1">
        {section('Headers', headers)}
        {section(final ? 'Trailers' : 'Trailers (when the stream ends)', trailers)}
      </div>
    );
  }

  if (stream.events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-pm-text-muted">
        <Radio size={22} className={stream.active ? 'animate-pulse opacity-60' : 'opacity-40'} />
        <p className="text-xs">{stream.active ? 'Connecting…' : 'No messages'}</p>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      onScroll={e => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="flex h-full flex-col gap-1 overflow-y-auto p-1"
    >
      {stream.droppedEvents > 0 && (
        <div className="px-2.5 py-1 text-[10.5px] italic text-pm-text-muted">
          {stream.droppedEvents} older event(s) hidden to keep the timeline fast.
        </div>
      )}
      {numbered.map(({ event, index }, i) => (
        <EventRow key={i} event={event} index={index} />
      ))}
      {stream.active && (
        <div className="flex items-center gap-2 px-2.5 py-1 text-[11px] text-pm-text-muted">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          {stream.sendingClosed ? 'Waiting for the server to finish…' : 'Stream open'}
        </div>
      )}
    </div>
  );
}
