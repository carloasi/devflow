// src/lib/executeOAuth2Flow.ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface OAuthCallbackPayload {
  code?: string;
  error?: string;
  error_description?: string;
}

interface OAuthResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

// já registrado no Azure AD — o mesmo usado no Postman
const REDIRECT_URI = 'https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad';

// Erro usado quando o próprio usuário desiste. Tem tipo próprio pra quem
// chama conseguir distinguir "falhou" de "cancelei", e não mostrar um toast de
// erro por uma ação deliberada.
export class OAuth2CancelledError extends Error {
  constructor() {
    super('OAuth flow cancelled');
    this.name = 'OAuth2CancelledError';
  }
}

export function isOAuth2Cancelled(err: unknown): boolean {
  return err instanceof OAuth2CancelledError;
}

export async function executeOAuth2Flow(
  config: any,
  signal?: AbortSignal
): Promise<OAuthResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: config.scope,
    response_mode: 'query',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${config.authUrl}?${params.toString()}`;

  return new Promise(async (resolve, reject) => {
    let unlisten: (() => void) | null = null;
    let onAbort: (() => void) | null = null;

    // Esta promise só se resolve quando o callback chega. Sem uma saída, fechar
    // a janela de login (ou simplesmente não concluir) deixava ela pendurada
    // pra sempre, e o botão preso em "Fetching Token...".
    const cleanup = () => {
      unlisten?.();
      unlisten = null;
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      onAbort = null;
    };

    if (signal?.aborted) {
      reject(new OAuth2CancelledError());
      return;
    }

    try {
      unlisten = await listen<OAuthCallbackPayload>('oauth-callback', (event) => {
        cleanup();

        if (event.payload.error) {
          reject(new Error(event.payload.error_description || event.payload.error));
          return;
        }
        if (event.payload.code) {
          resolve({ code: event.payload.code, codeVerifier, redirectUri: REDIRECT_URI });
        } else {
          reject(new Error('Callback received without a code.'));
        }
      });

      onAbort = () => {
        cleanup();
        // Fecha a janela de login junto: desistir no app e deixar a janela
        // aberta só confundiria, e um login concluído depois do cancelamento
        // dispararia um callback que ninguém mais espera.
        invoke('cancel_login_window').catch(() => {});
        reject(new OAuth2CancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      // Cancelar enquanto o listener era registrado: o abort acima já não
      // dispararia, então checa de novo antes de abrir a janela.
      if (signal?.aborted) {
        onAbort();
        return;
      }

      await invoke('start_login_window', { authUrl, redirectUri: REDIRECT_URI });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
//               webview.close();     // Fecha a janela antes de renderizar o erro azul
//       webview.once('tauri://close-requested', () => {
//-----------------------------------------------------


// import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

// export async function executeOAuth2Flow(config: any): Promise<string> {
//   return new Promise(async (resolve, reject) => {
//     try {
//       const params = new URLSearchParams({
//         client_id: config.clientId,
//         response_type: 'code',
//         redirect_uri: "https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad",
//         scope: config.scope,
//         response_mode: 'query',
//       });

//       console.log(config)

//       const finalUrl = `${config.authUrl}?${params.toString()}`;
//       console.log("URL final:", finalUrl);

//       const webview = new WebviewWindow('login-microsoft', {
//         url: finalUrl,
//         title: 'Fazer login com a Microsoft',
//         width: 600,
//         height: 700,
//       });

//       webview.once('tauri://created', () => {
//               webview.close();
//               resolve(code);
//             }
//           } catch (_) {}
//         } else if (url.includes('error=')) {
//           const urlObj = new URL(url);
//           const error = urlObj.searchParams.get('error_description') || 'Erro desconhecido';
//           cleanup();
//           webview.close();
//           reject(new Error(error));
//         }
//       }

//       function cleanup() {
//         unlistenNav();
//         unlistenNavigating();
//       }

//       console.log(webview);

//       webview.once('tauri://close-requested', () => {
//         cleanup();
//         reject(new Error('Login cancelado pelo usuário'));
//       });

//       webview.once('tauri://error', (e: any) => {
//       authUrl.searchParams.append('client_id', config.clientId);
//       authUrl.searchParams.append('response_type', 'code');
//       authUrl.searchParams.append('redirect_uri', 'https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad');
//       authUrl.searchParams.append('scope', config.scope);
//       authUrl.searchParams.append('response_mode', 'query');

//       const webview = new WebviewWindow('login-microsoft', {
//         url: authUrl.toString(),
//         title: 'Fazer login com a Microsoft',
//         width: 600,
//         height: 700,
//       });

//       console.log(webview)

//       // Tauri v2: evento correto para interceptar navegação
//       const unlisten = await webview.listen<string>('tauri://navigation', (event) => {
//         const url = typeof event.payload === 'string' 
//           ? event.payload 
//           : (event.payload as any)?.url;

//         console.log("Navegando para:", url);

//         if (url?.includes(config.callbackUrl) && url.includes('code=')) {
//           const urlObj = new URL(url);
//           const code = urlObj.searchParams.get('code');

//           if (code) {
//             unlisten();
//             webview.close();
//             resolve(code);
//           }
//         }
//       });

//       console.log(unlisten)

//       webview.once('tauri://close-requested', () => {
//         unlisten();
//         reject(new Error('Login cancelado pelo usuário'));
//       });

//       webview.once('tauri://error', (e) => {
//       authUrl.searchParams.append('client_id', config.clientId);
//       authUrl.searchParams.append('response_type', 'code');
//       authUrl.searchParams.append('redirect_uri', 'https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad');
//       authUrl.searchParams.append('scope', config.scope);

//       console.log(authUrl)

//       // 1. Cria a janela normalmente
//       const webview = new WebviewWindow('login-microsoft', {
//         url: authUrl.toString(),
//         title: 'Fazer login com a Microsoft',
//         width: 600,
//         height: 700,
//       });

//       console.log(webview)

//       // 🚀 2. Solução para o Tauri v2: Escutar o evento de navegação da Webview
//       // No Tauri v2, mudanças de URL disparam o evento nativo 'tauri://navigating'
//       webview.listen<{ url: string }>('tauri://navigating', (event) => {
//         const url = event.payload.url;
//         console.log("Navegando para:", url);

//         if (url.includes(config.callbackUrl) && url.includes('code=')) {
//           const urlObj = new URL(url);
//           const code = urlObj.searchParams.get('code');

//           if (code) {
//             webview.close(); // Fecha a janela de erro azul imediatamente
//             resolve(code);   // Envia o código extraído para o RequestEditor
//           }
//         }
//       });

//            console.log(webview)

//       webview.once('tauri://error', function (e) {
//         reject(new Error(`Falha ao abrir janela de login: ${e.payload}`));
//       });

//     } catch (error) {
//         console.log(error)
//       reject(error);
//     }
//   });
// }


// //https://portalgrupos-tst.azul.corp/pt/br/login?callbackUrl=https%3A%2F%2Fportalgrupos-tst.azul.corp&error=OAuthCallback

// export function executeOAuth2Flow_(config: any): Promise<string> {
//   return new Promise(async (resolve, reject) => {
//     try {
//       const authUrl = new URL(config.authUrl);
//       authUrl.searchParams.append('client_id', config.clientId);
//       authUrl.searchParams.append('response_type', 'code');
//       authUrl.searchParams.append('redirect_uri', 'https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad'); 
//       authUrl.searchParams.append('scope', config.scope || 'openid profile offline_access');

//       // Chama o Rust diretamente. Segurança contornada com sucesso!
//       await invoke('open_browser_url', { url: authUrl.toString() });

//       alert("Por favor, complete o login no seu navegador.");

//     } catch (error) {
//       reject(error);
//     }
//   });
// }

// export function executeOAuth2Flow_old2(config: any): Promise<string> {
//   return new Promise(async (resolve, reject) => {
//     try {
//       // 1. Monta a URL de Autorização
//       const authUrl = new URL(config.authUrl);
//       authUrl.searchParams.append('client_id', config.clientId);
//       authUrl.searchParams.append('response_type', 'code');
//       // Importante: certifique-se de que a porta aqui seja a mesma que seu servidor local vai escutar
//       authUrl.searchParams.append('redirect_uri', 'https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad'); 
//       authUrl.searchParams.append('scope', config.scope || 'openid profile offline_access');
//       authUrl.searchParams.append('client_id', config.clientId);
//       authUrl.searchParams.append('response_type', 'code');
//       authUrl.searchParams.append('redirect_uri', 'https://portalgrupos-tst.azul.corp/api/auth/callback/azure-ad');
//       authUrl.searchParams.append('scope', config.scope || 'openid');
//       webview.once('tauri://created', function () {
//         // Janela criada com sucesso!
//       });

//       webview.once('tauri://error', function (e) {