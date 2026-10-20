"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Settings, LogOut, Copy, Check, ChevronDown, ImagePlus, RotateCcw } from "lucide-react";
import { AVATAR_SIZE, squareCrop, validateAvatarFile, ACCEPTED_AVATAR_TYPES } from "@/lib/avatarImage";
import { AVATAR_PRESETS, avatarDataUrl, presetIdOf, type AvatarPreset } from "@/lib/avatarPresets";

const STORAGE_KEY = "app_win_username";
const PHOTO_STORAGE_KEY = "app_win_photo";
// Avatar escolhido pelo usuário. Chave separada da foto do Windows pra que
// "Reload identity" releia uma sem descartar a outra.
const CUSTOM_PHOTO_KEY = "devflow_custom_avatar";

interface UserBadgeProps {
  onOpenSettings?: () => void;
}

export default function UserBadge({ onOpenSettings }: UserBadgeProps) {
  const [username, setUsername] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [customPhoto, setCustomPhoto] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // O escolhido vence o do Windows — é a escolha explícita.
  const avatar = customPhoto ?? photo;
  // Identifica a escolha comparando o que está guardado com o que cada preset
  // gera — por isso a geração precisa ser determinística (ver avatarPresets).
  const selectedPresetId = presetIdOf(customPhoto);
  const [loading, setLoading] = useState(true);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const badgeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    async function fetchUserData() {
      try {
        // Dentro do fluxo assíncrono, e não num setState direto no efeito:
        // ler localStorage na inicialização do estado quebraria a
        // pré-renderização estática, onde ele não existe.
        setCustomPhoto(localStorage.getItem(CUSTOM_PHOTO_KEY));

        const cachedUser = localStorage.getItem(STORAGE_KEY);
        const cachedPhoto = localStorage.getItem(PHOTO_STORAGE_KEY);

        if (cachedUser) {
          setUsername(cachedUser);
        } else {
          const winUser = await invoke<string>("get_windows_username");
          if (winUser) {
            localStorage.setItem(STORAGE_KEY, winUser);
            setUsername(winUser);
          }
        }

        if (cachedPhoto) {
          setPhoto(cachedPhoto);
        } else {
          try {
            const winPhoto = await invoke<string | null>("get_windows_user_photo");
            if (winPhoto) {
              localStorage.setItem(PHOTO_STORAGE_KEY, winPhoto);
              setPhoto(winPhoto);
            }
          } catch (photoError) {
            console.error("Erro ao obter foto do Windows:", photoError);
          }
        }
      } catch (error) {
        console.error("Erro ao obter usuário do Windows:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchUserData();

    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setAppVersion(await getVersion());
      } catch (e) {
        console.error("Erro ao obter versão do app:", e);
      }
    })();
  }, []);

  // Posiciona o menu abaixo do badge, alinhado à direita
  useEffect(() => {
    if (!menuOpen || !badgeRef.current) return;
    const rect = badgeRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 8,
      left: Math.min(rect.right - 260, window.innerWidth - 268),
    });
  }, [menuOpen]);

  // Fecha ao clicar fora / Esc
  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        badgeRef.current &&
        !badgeRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const handleCopyUsername = async () => {
    if (!username) return;
    try {
      await navigator.clipboard.writeText(username);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Erro ao copiar usuário:", e);
    }
  };

  const handleClearCache = () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PHOTO_STORAGE_KEY);
    // O avatar escolhido NÃO é apagado aqui: "Reload identity" relê o que vem
    // do Windows, e descartar a escolha do usuário junto seria um efeito que
    // o nome da ação não anuncia. Pra voltar à foto do Windows existe o
    // "Use Windows photo".
    setMenuOpen(false);
    window.location.reload();
  };

  // Converte o arquivo escolhido num quadrado de 128px.
  //
  // Redimensiona antes de guardar porque o destino é o localStorage, de cota
  // compartilhada: uma foto de celular em base64 passa de 5MB e derruba as
  // gravações de outras features.
  const handlePickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Zera o input: escolher o MESMO arquivo de novo não dispara change se o
    // valor continuar lá.
    e.target.value = "";
    if (!file) return;

    const check = validateAvatarFile(file);
    if (!check.ok) {
      setAvatarError(check.error);
      return;
    }
    setAvatarError(null);

    try {
      const bitmap = await createImageBitmap(file);
      const { x, y, side } = squareCrop(bitmap.width, bitmap.height);

      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is not available.");
      ctx.drawImage(bitmap, x, y, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      bitmap.close();

      // PNG, não JPEG: o avatar é pequeno, e o JPEG a 128px deixa artefato
      // visível em imagem com texto ou linhas finas.
      const dataUrl = canvas.toDataURL("image/png");
      localStorage.setItem(CUSTOM_PHOTO_KEY, dataUrl);
      setCustomPhoto(dataUrl);
      setMenuOpen(false);
    } catch (err) {
      setAvatarError("Could not read that image.");
      console.error("Erro ao processar avatar:", err);
    }
  };

  const handlePickPreset = (preset: AvatarPreset) => {
    const dataUrl = avatarDataUrl(preset);
    localStorage.setItem(CUSTOM_PHOTO_KEY, dataUrl);
    setCustomPhoto(dataUrl);
    setAvatarError(null);
    // O menu NÃO fecha: trocar de avatar é escolha visual, e fechar a cada
    // clique obrigaria a reabrir pra comparar com outro.
  };

  const handleUseWindowsPhoto = () => {
    localStorage.removeItem(CUSTOM_PHOTO_KEY);
    setCustomPhoto(null);
    setAvatarError(null);
    setMenuOpen(false);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2.5 py-1.5 pl-1.5 pr-3 rounded-full bg-pm-hover/60 border border-pm-border w-fit">
        <div className="w-8 h-8 rounded-full bg-pm-hover animate-pulse" />
        <div className="space-y-1.5">
          <div className="w-20 h-2.5 bg-pm-hover rounded-full animate-pulse" />
          <div className="w-14 h-2 bg-pm-hover/70 rounded-full animate-pulse" />
        </div>
      </div>
    );
  }

  const initial = username ? username.charAt(0).toUpperCase() : "U";

  return (
    <>
      <button
        ref={badgeRef}
        onClick={() => setMenuOpen((v) => !v)}
        className={`
          group relative flex items-center gap-2
          py-1 pl-1 pr-2
          rounded-[5px]
          border border-transparent
          transition-all duration-200 ease-out
          cursor-pointer
          w-fit
          ${menuOpen ? "bg-pm-hover border-pm-border" : "hover:bg-pm-hover"}
        `}
      >
        {/* Avatar */}
        <div className="relative flex items-center justify-center w-7 h-7 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10">
          {avatar ? (
            <img src={avatar} alt={username ?? "User"} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-400 via-blue-600 to-violet-600 text-white font-semibold text-[13px]">
              {initial}
            </div>
          )}
          {/* <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#1c1c1c]" /> */}
        </div>

        {/* Text */}
        {/* <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[10.5px] font-semibold text-zinc-100 group-hover:text-white transition-colors truncate max-w-[120px]">
            {username || "User"}
          </span>
        </div> */}

        <ChevronDown
          size={12}
          className={`text-pm-text-muted group-hover:text-pm-text-secondary transition-transform duration-200 ${menuOpen ? "rotate-180" : ""}`}
        />
      </button>

      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menuPos.top, left: menuPos.left }}
            className="fixed z-[100000] w-[260px] bg-pm-surface border border-pm-border rounded-xl shadow-2xl shadow-black/60 overflow-hidden font-sans animate-in fade-in slide-in-from-top-1 duration-150"
          >
            {/* Header do usuário */}
            <div className="flex items-center gap-3 px-3.5 py-3 border-b border-pm-border bg-pm-hover/30">
              <div className="relative flex items-center justify-center w-10 h-10 rounded-full overflow-hidden shrink-0 ring-1 ring-white/10">
                {avatar ? (
                  <img src={avatar} alt={username ?? "User"} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-400 via-blue-600 to-violet-600 text-white font-semibold text-[15px]">
                    {initial}
                  </div>
                )}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-[13px] font-semibold text-pm-text truncate">
                  {username || "User"}
                </span>
                <span className="text-[10.5px] text-pm-text-muted">
                  {customPhoto ? "Windows account · custom avatar" : "Windows account"}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="p-1">
              <button
                onClick={handleCopyUsername}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 text-[12px] text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
              >
                {copied ? (
                  <Check size={13} className="text-emerald-400" />
                ) : (
                  <Copy size={13} className="text-pm-text-muted" />
                )}
                <span>{copied ? "Copied!" : "Copy username"}</span>
              </button>

              {onOpenSettings && (
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenSettings();
                  }}
                  className="flex items-center gap-2.5 w-full px-2.5 py-2 text-[12px] text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
                >
                  <Settings size={13} className="text-pm-text-muted" />
                  <span>Settings</span>
                </button>
              )}
            </div>

            <div className="h-px bg-pm-border mx-1" />

            <div className="p-2 flex flex-col gap-2">
              <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
                Avatar
              </span>

              {/* Grade antes do botão de carregar: escolher um pronto é um
                  clique, e enviar arquivo é o caminho mais longo — quem só
                  quer trocar a imagem não precisa abrir o seletor do sistema. */}
              <div className="grid grid-cols-6 gap-1.5">
                {AVATAR_PRESETS.map(preset => {
                  const selected = selectedPresetId === preset.id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => handlePickPreset(preset)}
                      title={preset.name}
                      aria-label={preset.name}
                      className={`relative h-8 w-8 overflow-hidden rounded-full border transition-colors cursor-pointer ${
                        selected ? 'border-[#047ae7] ring-1 ring-[#047ae7]' : 'border-pm-border hover:border-pm-text-muted'
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={avatarDataUrl(preset)} alt={preset.name} className="h-full w-full" />
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px] text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover transition-colors"
                >
                  <ImagePlus size={13} className="shrink-0 text-pm-text-muted" />
                  <span>Upload image…</span>
                </button>

                {/* Só aparece quando há escolha a desfazer: um botão permanente
                    de "voltar ao padrão" sugere que algo foi alterado mesmo
                    quando nada foi. */}
                {customPhoto && (
                  <button
                    onClick={handleUseWindowsPhoto}
                    title="Use the Windows account photo again"
                    className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-pm-text-muted bg-transparent border-none cursor-pointer hover:bg-pm-hover hover:text-pm-text transition-colors"
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>

              {avatarError && (
                <p className="px-0.5 text-[10.5px] text-[#e06c75]">{avatarError}</p>
              )}
            </div>

            <div className="p-1 border-t border-pm-border">
              <button
                onClick={handleClearCache}
                className="flex items-center gap-2.5 w-full px-2.5 py-2 text-[12px] text-[#e06c75] bg-transparent border-none text-left cursor-pointer hover:bg-[#e06c75]/10 rounded-md transition-colors"
              >
                <LogOut size={13} />
                <span>Reload identity</span>
              </button>
            </div>

            {appVersion && (
              <div className="px-3.5 py-2 border-t border-pm-border bg-pm-hover/20">
                <span className="text-[10px] text-pm-text-muted font-mono">DevFlow v{appVersion}</span>
              </div>
            )}
          </div>,
          document.body
        )}

      {/* Fora do portal do menu: o menu desmonta ao fechar, e com o input
          dentro dele o seletor de arquivo do sistema perderia o elemento que
          dispara o `change` enquanto o usuário escolhe. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_AVATAR_TYPES.join(',')}
        onChange={handlePickAvatar}
        className="hidden"
      />
    </>
  );
}

// "use client";

// import { useEffect, useState } from "react";
// import { invoke } from "@tauri-apps/api/core";

// const STORAGE_KEY = "app_win_username";
// const PHOTO_STORAGE_KEY = "app_win_photo";

// export default function UserBadge() {
//   const [username, setUsername] = useState<string | null>(null);
//   const [photo, setPhoto] = useState<string | null>(null);
//   const [loading, setLoading] = useState(true);

//   useEffect(() => {
//     async function fetchUserData() {
//       try {
//         const cachedUser = localStorage.getItem(STORAGE_KEY);
//         const cachedPhoto = localStorage.getItem(PHOTO_STORAGE_KEY);

//         if (cachedUser) {
//           setUsername(cachedUser);
//         } else {
//           const winUser = await invoke<string>("get_windows_username");
//           if (winUser) {
//             localStorage.setItem(STORAGE_KEY, winUser);
//               localStorage.setItem(PHOTO_STORAGE_KEY, winPhoto);
//         group relative flex items-center gap-2.5
//         py-1.5 pl-1.5 pr-2
//         rounded-[5px]
    
//         hover:bg-white/[0.06]
//         hover:border-white/[0.1]
//         transition-all duration-300 ease-out
//         cursor-default
//         w-fit
//       "
//     >
//       {/* Avatar */}
//       <div
//         className="
//           relative flex items-center justify-center
//           w-7 h-7 rounded-full
//           overflow-hidden
//           shrink-0
//           ring-1 ring-white/10
  
//         "
//       >
//         {avatar ? (
//           <img
//             src={photo}
//             alt={username ?? "Usuário"}
//             className="w-full h-full object-cover"
//           />
//           Online
//         </span> */}
//       </div>
//     </div>
//   );
// }

//-----------------------------------------------------------------------------------------------

// "use client";

// import { useEffect, useState } from "react";
// import { invoke } from "@tauri-apps/api/core";

// const STORAGE_KEY = "app_win_username";

// export default function UserBadge() {
//   const [username, setUsername] = useState<string | null>(null);
//   const [loading, setLoading] = useState(true);

//   useEffect(() => {
//     async function fetchUsername() {
//       try {
//         const cachedUser = localStorage.getItem(STORAGE_KEY);

//         if (cachedUser) {
//           setUsername(cachedUser);
//           setLoading(false);
//           return;
//         }

//         const winUser = await invoke<string>("get_windows_username");

//         if (winUser) {
//           localStorage.setItem(STORAGE_KEY, winUser);