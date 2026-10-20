"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState, useEffect, type ReactNode } from "react";

interface TitleBarProps {
  leftContent?: ReactNode;
  rightContent?: ReactNode;
}

export function TitleBar({ leftContent, rightContent }: TitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();

    appWindow.isMaximized().then(setIsMaximized);

    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximizeRestore = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();

  return (
    <header
      data-tauri-drag-region
      className="h-11 border-b border-pm-border flex items-center justify-between px-0 shrink-0 bg-pm-bg select-none"
    >
      {/* Lado esquerdo - conteúdo do app, interativo */}
      <div className="flex items-center gap-0 h-full pl-3">
        {leftContent}
      </div>

      {/* Lado direito - conteúdo do app + controles de janela */}
      <div className="flex items-center h-full">
        {rightContent && (
          <div className="flex items-center gap-2 pr-3 mr-0 border-r border-pm-border h-full">
            {rightContent}
          </div>
        )}

        {/* Minimizar */}
        <button
          onClick={handleMinimize}
          className="w-11 h-full flex items-center justify-center text-pm-text-muted px-3 hover:bg-pm-hover cursor-pointer hover:text-pm-text transition-colors"
          title="Minimizar"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>

        {/* Maximizar / Restaurar */}
        <button
          onClick={handleMaximizeRestore}
          className="w-11 h-full flex items-center justify-center text-pm-text-muted px-3 hover:bg-pm-hover cursor-pointer hover:text-pm-text transition-colors"
          title={isMaximized ? "Restaurar" : "Maximizar"}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="0" width="8" height="8" />
              <polyline points="0,2 0,10 8,10" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0" y="0" width="10" height="10" />
            </svg>
          )}
        </button>

        {/* Close */}
        <button
          onClick={handleClose}
          className="w-11 h-full flex items-center justify-center text-pm-text-muted px-3 hover:bg-rose-500 cursor-pointer hover:text-white transition-colors"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="0" y1="0" x2="10" y2="10" />
            <line x1="10" y1="0" x2="0" y2="10" />
          </svg>
        </button>
      </div>
    </header>
  );
}

// "use client";

// import { getCurrentWindow } from "@tauri-apps/api/window";
// import { useState, useEffect } from "react";

// export function TitleBar() {
//   const [isMaximized, setIsMaximized] = useState(false);

//   useEffect(() => {
//     const appWindow = getCurrentWindow();

//     // Verifica estado inicial
//     appWindow.isMaximized().then(setIsMaximized);

//     // Escuta mudanças de estado da janela
//     const unlisten = appWindow.onResized(() => {
//       appWindow.isMaximized().then(setIsMaximized);
//     });

//     return () => {
//       unlisten.then((fn) => fn());
//     };
//   }, []);

//   const handleMinimize = () => getCurrentWindow().minimize();
//   const handleMaximizeRestore = () => getCurrentWindow().toggleMaximize();
//   const handleClose = () => getCurrentWindow().close();

//   return (
//     <header
//       data-tauri-drag-region
//       className="h-8 border-b border-zinc-800 flex items-center justify-between px-3 shrink-0 bg-[#1c1c1c] select-none"
//     >
//         >
//         >
//         >