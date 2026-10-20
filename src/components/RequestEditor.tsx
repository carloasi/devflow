'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type { OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { ClipboardPaste, Copy, Eye, EyeOff, Lock, ChevronDown, Plus } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HeadersManager } from './HeadersManager';
import { getDefaultHeaderStates } from '@/lib/defaultHeaders';
import { buildEnvMap } from '@/lib/envMap';
import RequestBodyEditor from './RequestBodySelector';
import { AuthorizationDetails } from '@/app/types/AuthorizationDetails';
import { ParamsTab } from './Url-components/ParamsTab';
import { UrlInputWithVariables } from './Url-components/UrlInputWithVariables';
import { executeOAuth2Flow, isOAuth2Cancelled } from '@/lib/executeOAuth2Flow';
import { invoke } from '@tauri-apps/api/core';
import { Tab, RequestSubTab } from '@/app/types/Tab';
import { QueryParam } from '@/app/types/QueryParam';
import { EnvironmentValue } from '@/app/types/Environment';
import { useEnvironment } from '@/components/EnvironmentContext';
import { isMacPlatform } from '@/lib/platform';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Detecta um par "chave": valor (formato JSON) numa seleção — usado pelo
// Ctrl+Space (ver createVariableFromScriptSelection) pra criar a variável
// com o nome da CHAVE e o valor inicial igual ao VALOR selecionado, em vez
// de usar o texto inteiro como nome. Mesmo padrão do HttpBodyEditor.tsx.
const KEY_VALUE_REGEX = /^\s*"([^"]+)"\s*:\s*(.+?),?\s*$/;

// Snippets rápidos de pm.test(...), no estilo dos que o Postman oferece na
// aba de scripts. Inserem um teste pronto no post-response script — só
// funcionam de verdade lá (pm.response só existe depois da resposta chegar).
const TEST_SNIPPETS: { label: string; code: string }[] = [
  {
    label: 'Status code is 200',
    code: 'pm.test("Status code is 200", function () {\n    pm.response.to.have.status(200);\n});',
  },
  {
    label: 'Response is successful (2xx)',
    code: 'pm.test("Response is successful", function () {\n    pm.response.to.be.ok;\n});',
  },
  {
    label: 'Response time is below 200ms',
    code: 'pm.test("Response time is less than 200ms", function () {\n    pm.expect(pm.response.responseTime).to.be.below(200);\n});',
  },
  {
    label: 'Response body has JSON value',
    code: 'pm.test("Response has correct value", function () {\n    const jsonData = pm.response.json();\n    pm.expect(jsonData.value).to.eql(100);\n});',
  },
  {
    label: 'Response body contains string',
    code: 'pm.test("Body contains string", function () {\n    pm.expect(pm.response.text()).to.include("success");\n});',
  },
  {
    label: 'Response header check',
    code: 'pm.test("Content-Type header is present", function () {\n    pm.response.to.have.header("Content-Type");\n});',
  },
];

const CodeEditor = dynamic(
  () => import('./CodeEditor').then((mod) => mod.CodeEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center bg-pm-bg text-xs text-pm-text-muted">
        Loading editor...
      </div>
    ),
  }
);

const REQUEST_SUB_TABS = ['Params', 'Authorization', 'Headers', 'Body', 'Scripts'];
const EXAMPLE_SUB_TABS = ['Params', 'Headers', 'Body'];

interface RequestEditorProps {
  activeTab: Tab;
  requestBodyValue: string;
  updateActiveTab: (updates: Partial<Tab>) => void;
  setRequestBodyValue: (value: string) => void;
  updateRequestScript: (type: 'preRequest' | 'postResponse', value: string) => void;
  requestHeadersValue: QueryParam[];
  setRequestHeadersValue: (
    headers: QueryParam[] | ((prev: QueryParam[]) => QueryParam[])
  ) => void;
  bodyType: "none" | "raw" | "graphql";
  setBodyType: (type: "none" | "raw" | "graphql") => void;
  auth: AuthorizationDetails;
  setAuth: (auth: AuthorizationDetails) => void;
}

export function RequestEditor({
  activeTab,
  requestBodyValue,
  updateRequestScript,
  setRequestBodyValue,
  requestHeadersValue,
  setRequestHeadersValue,
  bodyType,
  setBodyType,
  auth,
  setAuth,
  updateActiveTab
}: RequestEditorProps) {

  const [isFetchingToken, setIsFetchingToken] = useState(false);
  // Controlador do fluxo OAuth em curso — existe só pra dar ao usuário uma
  // saída enquanto a janela de login está aberta.
  const oauthAbortRef = useRef<AbortController | null>(null);

  const cancelTokenFetch = useCallback(() => {
    oauthAbortRef.current?.abort();
  }, []);

  // Sair da aba/tela no meio do fluxo também cancela: sem isso ficaria uma
  // janela de login órfã e um listener esperando um callback que ninguém mais
  // vai usar.
  useEffect(() => () => oauthAbortRef.current?.abort(), []);
  const { activeEnv, setEnvironments, updateEnvironment, recordPreviousVariableValue } = useEnvironment();

  const [activeScriptTab, setActiveScriptTab] = useState<'pre-request' | 'post-response'>(
    'post-response'
  );

  const currentScriptValue = useMemo(() => {
    return activeScriptTab === 'pre-request'
      ? activeTab.scripts?.preRequest || ''
      : activeTab.scripts?.postResponse || '';
  }, [activeScriptTab, activeTab.scripts]);

  const handleScriptChange = (value: string) => {
    updateRequestScript(
      activeScriptTab === 'pre-request' ? 'preRequest' : 'postResponse',
      value
    );
  };

  const handleInsertSnippet = (code: string) => {
    const next = currentScriptValue.trim()
      ? `${currentScriptValue}\n\n${code}`
      : code;
    handleScriptChange(next);
  };

  // ── Ctrl/Cmd+Space no editor de Scripts (Pre-request/Post-response): com
  // uma seleção ativa, cria uma variável no environment ativo com o nome
  // igual ao texto selecionado (valor em branco) e mostra uma dica
  // "Ctrl+Space to create a variable" perto da seleção — mesmo padrão já
  // usado no editor de body (ver HttpBodyEditor.tsx). Diferente do body,
  // aqui a seleção NÃO é substituída no texto (o script continua igual);
  // só cria a variável no environment, pra usar depois via
  // pm.environment.get(...).
  const scriptEditorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const [scriptSelectionHint, setScriptSelectionHint] = useState<{ x: number; y: number } | null>(null);

  const scriptPositionToClientCoords = useCallback((pos: { lineNumber: number; column: number }) => {
    const ed = scriptEditorRef.current;
    if (!ed) return { x: 0, y: 0 };
    const domNode = ed.getDomNode();
    const scrolled = ed.getScrolledVisiblePosition(pos);
    if (!domNode || !scrolled) return { x: 0, y: 0 };
    const rect = domNode.getBoundingClientRect();
    return { x: rect.left + scrolled.left, y: rect.top + scrolled.top + scrolled.height };
  }, []);

  const createVariableFromScriptSelection = useCallback((): boolean => {
    const ed = scriptEditorRef.current;
    if (!ed) return false;

    const selection = ed.getSelection();
    if (!selection || selection.isEmpty()) return false;

    const model = ed.getModel();
    if (!model) return false;

    const selectedText = model.getValueInRange(selection);
    const trimmed = selectedText.trim();

    // Já é uma "{{variavel}}" — não faz sentido criar variável em cima disso.
    if (/^\{\{[\s\S]+\}\}$/.test(trimmed)) return true;

    if (!activeEnv) {
      toast.error('Select an environment first to create a variable.');
      return true;
    }

    // Selecionou um par "chave": valor (ex: "token": "abc123") — usa a
    // chave como nome da variável e o valor atual como valor inicial. O
    // script continua igual (não substitui nada), só cria a variável.
    const kvMatch = trimmed.match(KEY_VALUE_REGEX);
    let varName: string;
    let initialValue: string;

    if (kvMatch) {
      const [, rawKey, rawValue] = kvMatch;
      varName = rawKey.trim();
      const valueIsQuotedString = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"');
      initialValue = valueIsQuotedString ? rawValue.slice(1, -1) : rawValue;
    } else {
      const isQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
      varName = (isQuoted ? trimmed.slice(1, -1) : trimmed).trim();
      initialValue = '';
    }

    if (!varName) return true;

    const existingIndex = activeEnv.values.findIndex(v => v.key === varName && v.enabled);
    if (existingIndex === -1) {
      const newValue: EnvironmentValue = {
        id: crypto.randomUUID(),
        key: varName,
        value: initialValue,
        type: 'default',
        enabled: true,
      };
      updateEnvironment({ ...activeEnv, values: [...activeEnv.values, newValue] });
      toast.success(`Variable "${varName}" created in "${activeEnv.name}".`);
    } else if (kvMatch) {
      // Variável já existe e a seleção era um par "chave": valor — atualiza
      // o valor pro que acabou de ser selecionado (em vez de manter o valor
      // antigo intocado), guardando o valor anterior no histórico.
      const existing = activeEnv.values[existingIndex];
      if (existing.value !== initialValue) {
        recordPreviousVariableValue(varName, existing.value);
        const updatedValues = activeEnv.values.map((v, i) =>
          i === existingIndex ? { ...v, value: initialValue } : v
        );
        updateEnvironment({ ...activeEnv, values: updatedValues });
        toast.success(`Variable "${varName}" updated in "${activeEnv.name}".`);
      }
    }

    return true;
  }, [activeEnv, updateEnvironment, recordPreviousVariableValue]);

  const handleScriptEditorMount: OnMount = useCallback((editorInstance, monacoInstance) => {
    scriptEditorRef.current = editorInstance;

    editorInstance.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Space,
      () => {
        // Sem seleção, mantém o IntelliSense padrão do Monaco (sobrescrito
        // por esse addCommand) — só intercepta de verdade quando há texto
        // selecionado.
        if (!createVariableFromScriptSelection()) {
          editorInstance.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }
      }
    );

    editorInstance.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      if (!sel || sel.isEmpty()) {
        setScriptSelectionHint(null);
        return;
      }
      const model = editorInstance.getModel();
      const selectedText = model ? model.getValueInRange(sel).trim() : '';
      if (/^\{\{[\s\S]+\}\}$/.test(selectedText)) {
        setScriptSelectionHint(null);
        return;
      }
      setScriptSelectionHint(
        scriptPositionToClientCoords({ lineNumber: sel.endLineNumber, column: sel.endColumn })
      );
    });

    editorInstance.onDidChangeModelContent(() => setScriptSelectionHint(null));
    editorInstance.onDidScrollChange(() => setScriptSelectionHint(null));
  }, [createVariableFromScriptSelection, scriptPositionToClientCoords]);

  // Insere/atualiza um header por chave (case-insensitive, igual header HTTP
  // de verdade) — se não existir ainda, cria habilitado; se existir, só
  // atualiza o valor e reabilita (mesmo comportamento que sobrescrever uma
  // chave num Record<string,string> tinha antes).
  const upsertHeaderByKey = (list: QueryParam[], key: string, value: string): QueryParam[] => {
    const idx = list.findIndex((h) => h.key.toLowerCase() === key.toLowerCase());
    if (idx === -1) {
      return [...list, { id: crypto.randomUUID(), key, value, enabled: true }];
    }
    return list.map((h, i) => (i === idx ? { ...h, value, enabled: true } : h));
  };

  const removeHeaderByKey = (list: QueryParam[], key: string): QueryParam[] =>
    list.filter((h) => h.key.toLowerCase() !== key.toLowerCase());

  const handleAuthTypeChange = (type: AuthorizationDetails['type']) => {
    if (type === 'none') {
      setRequestHeadersValue((prev) => removeHeaderByKey(prev, 'Authorization'));
      setAuth({
        type: 'none',
        token: ''
      });
      return;
    }

    if (type === 'bearer') {
      const token = auth.token || '';
      const value = token.trim() ? `Bearer ${token}` : '';
      setRequestHeadersValue((prev) => upsertHeaderByKey(prev, 'Authorization', value));
      setAuth({
        ...auth,
        type: 'bearer',
        token
      });
    }

    if (type === 'oauth2') {
      setAuth({
        ...auth,
        type: 'oauth2',
        oauth2: auth.oauth2 || [
          { key: 'accessToken', value: '', enabled: true },
          { key: 'headerPrefix', value: 'Bearer', enabled: true },
          { key: 'tokenName', value: '', enabled: true },
          { key: 'grantType', value: 'authorization_code', enabled: true },
          { key: 'callbackUrl', value: '', enabled: true },
          { key: 'authUrl', value: '', enabled: true },
          { key: 'accessTokenUrl', value: '', enabled: true },
          { key: 'clientId', value: '', enabled: true },
          { key: 'clientSecret', value: '', enabled: true },
          { key: 'scope', value: '', enabled: true }   // 👈 novo
        ]
      });
    }
  };

  function replaceWithEnv(text: string, envMap: Record<string, string>): string {
  if (!text) return '';
  return text.replace(/\{\{(.*?)\}\}/g, (_, key) => envMap[key.trim()] ?? `{{${key.trim()}}}`);
}

  const handleTokenChange = (token: string) => {
    setRequestHeadersValue((prev) =>
      token.trim()
        ? upsertHeaderByKey(prev, 'Authorization', `Bearer ${token}`)
        : removeHeaderByKey(prev, 'Authorization')
    );
    setAuth({
      ...auth,
      token
    });
  };

  const handleOAuth2Change = (key: string, value: string) => {
    const currentOauth2 = auth.oauth2 || [];
    const exists = currentOauth2.some(item => item.key === key);

    let updatedOauth2;
    if (exists) {
      updatedOauth2 = currentOauth2.map(item => 
        item.key === key ? { ...item, value } : item
      );
    } else {
      updatedOauth2 = [...currentOauth2, { key, value, enabled: true }];
    }

    setAuth({
      ...auth,
      oauth2: updatedOauth2
    });
  };

  const getOAuth2Value = (key: string): string => {
    return auth.oauth2?.find(item => item.key === key)?.value || '';
  };

  const scripts = activeTab.scripts as any;

  const scriptErrors = {
    preRequest: scripts?.preRequestError || false,
    postResponse: scripts?.postResponseError || false
  };
  const hasScriptError = Boolean(scriptErrors.preRequest || scriptErrors.postResponse);

  // Array.isArray porque uma tab ainda no formato antigo (Record em vez de
  // array) chegaria aqui truthy e quebraria o .some abaixo.
  const hasHeaders = Array.isArray(requestHeadersValue)
    && requestHeadersValue.some((h) => h.enabled && h.key.trim().length > 0);
  const hasBody = Boolean(activeTab.requestBodyValue.length > 0);
  const hasScripts = Boolean(activeTab.scripts?.preRequest || activeTab.scripts?.postResponse);
  const hasScriptsPre = Boolean(activeTab.scripts?.preRequest);
  const hasScriptsPos = Boolean(activeTab.scripts?.postResponse);
  const hasAuth = auth.type !== 'none';
  const hasParamns = Boolean(
    activeTab.params.some(p => p.enabled && p.key.trim().length > 0) ||
    activeTab.queryParams.some(p => p.enabled && p.key.trim().length > 0)
  );
  const [showClientId, setShowClientId] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showClientSecret, setShowClientSecret] = useState(false);

const handleGetNewAccessToken = async () => {
  const envMap: Record<string, string> = buildEnvMap(activeEnv?.values);

  const authUrl = replaceWithEnv(getOAuth2Value('authUrl').trim(), envMap);
  const accessTokenUrl = replaceWithEnv(getOAuth2Value('accessTokenUrl').trim(), envMap);
  const clientId = replaceWithEnv(getOAuth2Value('clientId').trim(), envMap);
  const clientSecret = replaceWithEnv(getOAuth2Value('clientSecret').trim(), envMap);
  const callbackUrl = replaceWithEnv(getOAuth2Value('callbackUrl').trim(), envMap);
  const scope = replaceWithEnv(getOAuth2Value('scope').trim(), envMap);

  const missingFields = [
    !authUrl && 'Auth URL',
    !accessTokenUrl && 'Access Token URL',
    !clientId && 'Client ID',
    !clientSecret && 'Client Secret',
    !callbackUrl && 'Callback URL',
  ].filter(Boolean) as string[];

  if (missingFields.length > 0) {
    toast.error('Missing required fields', {
      description: `Fill in: ${missingFields.join(', ')}`,
    });
    return;
  }

  const oauthConfig = {
    authUrl,
    accessTokenUrl,
    clientId,
    clientSecret,
    callbackUrl,
    scope,
  };

    const loadingToastId = toast.loading('Requesting new token via OAuth 2.0...');

    const saveTokenToVariable = (variableName: string, value: string) => {
    const envId = activeEnv?.id;
    if (!envId) {
      toast.error('No active environment', {
        description: 'Select an environment before saving the token to the variable.'
      });
      return false;
    }

    setEnvironments(prev =>
      prev.map(env => {
        if (env.id !== envId) return env;

        const exists = env.values.some(v => v.key === variableName);
        const updatedValues = exists
          ? env.values.map(v =>
              v.key === variableName ? { ...v, value, enabled: true } : v
            )
          : [
              ...env.values,
              {
                id: crypto.randomUUID(),
                key: variableName,
                value,
                enabled: true,
                type: 'default' as const,
              },
            ];

        return { ...env, values: updatedValues };
      })
    );

    return true;
};

  const controller = new AbortController();
  oauthAbortRef.current?.abort();
  oauthAbortRef.current = controller;

  try {
    setIsFetchingToken(true);

    const { code, codeVerifier, redirectUri } = await executeOAuth2Flow(oauthConfig, controller.signal);

    const tokenData = await invoke<{
      access_token?: string;
      error?: string;
      error_description?: string;
    }>('exchange_code_for_token', {
      accessTokenUrl: oauthConfig.accessTokenUrl,
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      code,
      redirectUri,
      codeVerifier,
      scope: oauthConfig.scope,
    });

    toast.dismiss(loadingToastId);

    // Cancelado enquanto a troca do código acontecia: o token até chegou, mas
    // o usuário já desistiu — aplicar agora sobrescreveria o campo sem ele
    // esperar por isso.
    if (controller.signal.aborted) return;

    if (tokenData.access_token) {

      const currentAccessTokenField = getOAuth2Value('accessToken').trim();
      const variableMatch = currentAccessTokenField.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);

       if (variableMatch) {
        const variableName = variableMatch[1];
        const saved = saveTokenToVariable(variableName, tokenData.access_token);

      } else {
        handleOAuth2Change('accessToken', tokenData.access_token);
      }

      try {
        await navigator.clipboard.writeText(tokenData.access_token);
        toast.success('Token copied to clipboard.');
      } catch (clipErr) {
        console.error("Não foi possível copiar para o clipboard:", clipErr);
      }
    } else {
      console.error("A Microsoft recusou a troca do código:", tokenData);
      toast.error('Token validation error', {
        description: tokenData.error_description || tokenData.error || 'The authorization was refused by the provider.'
      });
    }

  } catch (err: any) {
    toast.dismiss(loadingToastId);

    // Desistir não é falha: um toast vermelho aqui faria o usuário procurar um
    // problema que ele mesmo causou de propósito.
    if (isOAuth2Cancelled(err)) {
      toast.info('Token request cancelled.');
      return;
    }

    console.error("Erro no fluxo OAuth2:", err);
    toast.error('Error getting token', {
      description: err.message || 'The OAuth 2.0 flow failed.'
    });
  } finally {
    if (oauthAbortRef.current === controller) oauthAbortRef.current = null;
    setIsFetchingToken(false);
  }
  };

    const isTokenVariable = (auth.token || '').trim().startsWith('{');

    const handlePasteToken = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) handleTokenChange(text.trim());
    } catch (e) {
      console.error('Erro ao colar do clipboard:', e);
      toast.error('Could not paste', {
        description: 'Check clipboard access permission.'
      });
    }
  };

  const handleCopyAccessToken = async () => {
    const fieldValue = getOAuth2Value('accessToken').trim();

    if (!fieldValue) {
      toast.error('No token to copy');
      return;
    }

    const variableMatch = fieldValue.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    let tokenToCopy = fieldValue;

    if (variableMatch) {
      const variableName = variableMatch[1];
      const variable = activeEnv?.values.find(v => v.key === variableName && v.enabled);

      if (!variable || !variable.value?.trim()) {
        toast.error('Empty or missing variable', {
          description: `Variable "{{${variableName}}}" is not defined in the active environment.`
        });
        return;
      }

      tokenToCopy = variable.value;
    }

    try {
      await navigator.clipboard.writeText(tokenToCopy);
      toast.success('Token copied to clipboard!', {
        description: variableMatch
          ? `Value of {{${variableMatch[1]}}} copied.`
          : undefined
      });
    } catch (e) {
      console.error('Erro ao copiar token:', e);
      toast.error('Could not copy the token');
    }
  };

  // Saved Example: igual o Postman, só Params / Headers / Body — auth e
  // scripts continuam guardados no snapshot (e vão junto no Try), só não
  // são editados aqui. Se a sub-aba lembrada era uma das escondidas, cai no
  // Body.
  const isExampleTab = activeTab.kind === 'example';
  const savedSubTab = activeTab.activeRequestTab || 'body';
  const visibleSubTab =
    isExampleTab && (savedSubTab === 'authorization' || savedSubTab === 'scripts') ? 'body' : savedSubTab;

  return (
    <div className="h-full flex flex-col overflow-hidden text-pm-text">
      <Tabs 
        value={visibleSubTab}
        onValueChange={(value) =>
          updateActiveTab({ activeRequestTab: value as RequestSubTab })
        }
        className="flex flex-col h-full gap-0">
        
        <div className="bg-pm-bg px-4 shrink-0">
          <TabsList className="h-10 bg-transparent p-0 flex justify-start gap-6">
            {(isExampleTab ? EXAMPLE_SUB_TABS : REQUEST_SUB_TABS).map((tab) => {
              const value = tab.toLowerCase();
              const isActiveIndicator =
                (tab === 'Headers' && hasHeaders) ||
                (tab === 'Scripts' && hasScripts) ||
                (tab === 'Body' && hasBody) || 
                (tab === 'Params' && hasParamns) ||
                (tab === 'Authorization' && hasAuth);

              return (
                <TabsTrigger
                  key={tab}
                  value={value}
                  className="
                    relative h-6 rounded-sm border-b-2 border-transparent bg-transparent px-1
                    text-[12px] font-medium text-pm-text-muted transition-all cursor-pointer hover:text-pm-text-secondary 
                    data-[state=active]:bg-pm-hover data-[state=active]:text-pm-text data-[state=active]:shadow-none flex items-center gap-1.5
                  "
                >
                  {tab}
                  {(isActiveIndicator || (tab === 'Scripts' && hasScriptError)) && (
                    <span
                      className={
                        tab === 'Scripts' && hasScriptError
                          ? 'flex h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]'
                          : 'w-[5px] h-[5px] rounded-full bg-[#10b981]'
                      }
                      title={tab === 'Scripts' && hasScriptError ? 'Script error' : undefined}
                    />
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

        </div>
        <div className="flex-1 overflow-hidden">

          <TabsContent value="params" className="h-full m-0 p-0 outline-none">
            <ParamsTab
              url={activeTab.urlInput}
              queryParams={activeTab.queryParams || []}
              pathParams={activeTab.params || []}
              onUrlChange={(url) => updateActiveTab({ urlInput: url })}
              onChangeQueryParams={(queryParams) => updateActiveTab({ queryParams })}
              onChangePathParams={(params) => updateActiveTab({ params })}
            />
          </TabsContent>

          <TabsContent value="authorization" className="h-full m-0 overflow-hidden outline-none">
            <div className="flex h-full text-[13px]">

              {/* Coluna esquerda: tipo de auth */}
              <div className="w-[220px] border-r border-pm-border p-4 shrink-0 flex flex-col gap-3">
                <div>
                  <label className="text-[11px] text-pm-text-muted block mb-1.5 font-medium">
                    Auth Type
                  </label>
                  <select
                    value={auth.type}
                    onChange={(e) => handleAuthTypeChange(e.target.value as any)}
                    className="w-full h-8 bg-pm-hover border border-pm-border text-pm-text-secondary text-[12px] px-2 rounded cursor-pointer outline-none focus:border-pm-border"
                  >
                    <option value="none">No Auth</option>
                    <option value="bearer">Bearer Token</option>
                    <option value="oauth2">OAuth 2.0</option>
                  </select>
                </div>

                {auth.type !== 'none' && (
                  <>
                    <p className="text-[11px] text-pm-text-muted linear-relaxed m-0">
                      The authorization data will be automatically generated when you send the request.
                    </p>
                    <div>
                      <label className="text-[11px] text-pm-text-muted block mb-1.5 font-medium">
                        Add authorization data to
                      </label>
                      <select className="w-full h-8 bg-pm-hover border border-pm-border text-pm-text-secondary text-[12px] px-2 rounded cursor-pointer outline-none focus:border-pm-border">
                        <option>Request Headers</option>
                        <option>Request URL</option>
                      </select>
                    </div>
                  </>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-5">

                {auth.type === 'none' && (
                  <div className="flex flex-col items-center justify-center h-full text-center max-w-sm mx-auto">
                    <p className="text-[12px] text-pm-text-muted leading-relaxed">
                      This request does not use any authorization. Learn more about <span className="text-orange-400 cursor-pointer hover:underline">authorizing requests</span>.
                    </p>
                  </div>
                )}

                {auth.type === 'bearer' && (
                  <div className="flex flex-col gap-4 max-w-2xl animate-in fade-in duration-150">

                    
                    <div className="flex items-start gap-0">
                      <div className="w-12 pt-1.5 shrink-0">
                        <label className="text-[12px] text-pm-text-muted font-medium">Token</label>
                      </div>
                      <div
                        className="flex-1 min-h-[32px] border border-pm-border rounded bg-pm-surface focus-within:border-blue-500  transition-colors px-2 py-2 flex items-center gap-2"
                      >
                        <div
                          className="flex-1 min-w-0"
                          /* Aplica a máscara de senha apenas se NÃO for variável e se showToken for false */
                           style={
                              !showToken && !isTokenVariable 
                                ? ({ WebkitTextSecurity: 'disc' } as React.CSSProperties) 
                                : undefined
                            }
                        >
                          <UrlInputWithVariables
                            value={auth.token || ''}
                            onChange={handleTokenChange}
                          />
                        </div>

                        {isTokenVariable ? (
                            ""
                        ) : (
                          <button
                            type="button"
                            onClick={() => setShowToken((v) => !v)}
                            className="shrink-0 text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
                            title={showToken ? 'Hide token' : 'Show token'}
                          >
                            {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="ml-12 text-[11px] text-blue-400/80 italic">
                      The authorization header will be automatically generated.
                    </div>
                  </div>
                )}

                {auth.type === 'oauth2' && (
                  <div className="flex flex-col gap-6 max-w-2xl animate-in fade-in duration-150">

                    <div className="pt-2 flex items-center gap-2">
                      <button
                        onClick={handleGetNewAccessToken}
                        disabled={isFetchingToken}
                        className={`
                          px-4 py-2 rounded text-[12px] font-semibold transition-colors cursor-pointer
                          ${isFetchingToken
                            ? 'bg-[#2F67CC] text-pm-text-muted cursor-not-allowed'
                            : 'bg-[#2F67CC] text-white hover:bg-[#0f54d3]'}
                        `}
                      >
                        {isFetchingToken ? 'Fetching Token...' : 'Get new access token'}
                      </button>

                      {/* O fluxo fica parado esperando o callback do provedor.
                          Sem esta saída, fechar a janela de login deixava o
                          botão travado em "Fetching Token..." até reiniciar. */}
                      {isFetchingToken && (
                        <button
                          onClick={cancelTokenFetch}
                          title="Stop waiting for the login and close the login window"
                          className="px-3 py-2 rounded text-[12px] font-semibold text-pm-text-secondary hover:text-pm-text bg-pm-hover hover:bg-pm-row-active border border-pm-border transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                    
                    <div className="flex flex-col gap-3">
                      <h4 className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider">Current Token</h4>

                      <div className="flex items-center gap-4">
                        <div className="w-28 shrink-0"><label className="text-[12px] text-pm-text-muted">Token</label></div>
                        <select className="flex-1 h-8 bg-pm-hover border border-pm-border text-pm-text-secondary text-[12px] px-2 rounded outline-none">
                          <option>Available Tokens</option>
                        </select>
                      </div>


                    <div className="flex items-center gap-4">
                      <div className="w-28 shrink-0"></div>
                      <button
                        type="button"
                        onClick={handleCopyAccessToken}
                        className="shrink-0 text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
                        title="Copy token"
                      >
                        <Copy size={13} />
                      </button>
                      <div className="flex-1 min-h-[32px] border border-pm-border rounded bg-pm-surface px-2 py-1 flex items-center gap-2 focus-within:border-blue-500/50 transition-colors">
                        <UrlInputWithVariables
                          placeholder="Token"
                          value={getOAuth2Value('accessToken')}
                          onChange={(val) => handleOAuth2Change('accessToken', val)}
                        />
                      </div>
                    </div>


                      <div className="flex items-center gap-4">
                        <div className="w-28 shrink-0"><label className="text-[12px] text-pm-text-muted">Header Prefix</label></div>
                        <div className="flex-1 min-h-[32px] border border-pm-border rounded bg-pm-surface px-2 py-1">
                          <UrlInputWithVariables
                            placeholder="Bearer"
                            value={getOAuth2Value('headerPrefix') || 'Bearer'}
                            onChange={(val) => handleOAuth2Change('headerPrefix', val)}
                          />
                        </div>
                      </div>
                    </div>

                    <hr className="border-pm-border" />

                  {/* Configure New Token Section */}
                  <div className="flex flex-col gap-3">
                    <h4 className="text-[11px] font-semibold text-pm-text-muted uppercase tracking-wider">Configure New Token</h4>

                    {[
                      { label: 'Token Name', key: 'tokenName', placeholder: 'Enter a token name...' },
                      { label: 'Callback URL', key: 'callbackUrl', placeholder: 'http://your-application.com/callback' },
                      { label: 'Auth URL', key: 'authUrl', placeholder: 'https://example.com/oauth/authorize' },
                      { label: 'Access Token URL', key: 'accessTokenUrl', placeholder: 'https://example.com/oauth/token' },
                      { label: 'Scope', key: 'scope', placeholder: 'openid profile offline_access api://.../.default' }, 
                    ].map((field) => (
                      <div key={field.key} className="flex items-center gap-4">
                        <div className="w-28 shrink-0"><label className="text-[12px] text-pm-text-muted">{field.label}</label></div>
                        <div className="flex-1 min-h-[32px] border border-pm-border rounded bg-pm-surface px-2 py-1 flex items-center gap-2 focus-within:border-blue-500/50 transition-colors">
                          <UrlInputWithVariables
                            placeholder={field.placeholder}
                            value={getOAuth2Value(field.key)}
                            onChange={(val) => handleOAuth2Change(field.key, val)}
                          />
                        </div>
                      </div>
                    ))}

                    {/* Client ID — mascarado */}
                    <div className="flex items-center gap-4">
                      <div className="w-28 shrink-0 flex items-center gap-1">
                        <label className="text-[12px] text-pm-text-muted">Client ID</label>
                        <Lock size={11} className="text-pm-text-muted" />
                      </div>
                      <div
                        className="flex-1 min-h-[32px] border border-pm-border rounded bg-pm-surface px-2 py-1 flex items-center gap-2 focus-within:border-blue-500/50 transition-colors"
                      >
                        <div
                          className="flex-1 min-w-0"
                          style={!showClientId ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                        >
                          <UrlInputWithVariables
                            placeholder="Enter Client ID"
                            value={getOAuth2Value('clientId')}
                            onChange={(val) => handleOAuth2Change('clientId', val)}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowClientId((v) => !v)}
                          className="shrink-0 text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
                          title={showClientId ? 'Hide Client ID' : 'Show Client ID'}
                        >
                          {showClientId ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>

                    {/* Client Secret — mascarado */}
                    <div className="flex items-center gap-4">
                      <div className="w-28 shrink-0 flex items-center gap-1">
                        <label className="text-[12px] text-pm-text-muted">Client Secret</label>
                        <Lock size={11} className="text-pm-text-muted" />
                      </div>
                      <div
                        className="flex-1 min-h-[32px] border border-pm-border rounded bg-pm-surface px-2 py-1 flex items-center gap-2 focus-within:border-blue-500/50 transition-colors"
                      >
                        <div
                          className="flex-1 min-w-0"
                          style={!showClientSecret ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                        >
                          <UrlInputWithVariables
                            placeholder="Enter Client Secret"
                            value={getOAuth2Value('clientSecret')}
                            onChange={(val) => handleOAuth2Change('clientSecret', val)}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowClientSecret((v) => !v)}
                          className="shrink-0 text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
                          title={showClientSecret ? 'Hide Client Secret' : 'Show Client Secret'}
                        >
                          {showClientSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="w-28 shrink-0"><label className="text-[12px] text-pm-text-muted">Grant type</label></div>
                      <select
                        className="flex-1 h-8 bg-pm-hover border border-pm-border text-pm-text-secondary text-[12px] px-2 rounded outline-none"
                        value={getOAuth2Value('grantType') || 'authorization_code'}
                        onChange={(e) => handleOAuth2Change('grantType', e.target.value)}
                      >
                        <option value="authorization_code">Authorization Code</option>
                        <option value="client_credentials">Client Credentials</option>
                        <option value="implicit">Implicit</option>
                        <option value="password">Password Credentials</option>
                      </select>
                    </div>
                  </div>

   

                  </div>
                )}
              </div>

            </div>
          </TabsContent>

          <TabsContent value="headers" className="h-full m-0 p-0 outline-none">
            <HeadersManager
              headersValue={requestHeadersValue}
              onChange={setRequestHeadersValue}
              autoHeaders={{
                states: getDefaultHeaderStates({
                  userHeaders: Array.isArray(requestHeadersValue) ? requestHeadersValue : [],
                  disabledDefaults: activeTab.disabledDefaultHeaders,
                  hasBody: bodyType !== 'none' && !!requestBodyValue?.trim(),
                  auth,
                }),
                onToggle: (key, enabled) => {
                  const current = activeTab.disabledDefaultHeaders ?? [];
                  const others = current.filter(k => k.toLowerCase() !== key.toLowerCase());
                  updateActiveTab({ disabledDefaultHeaders: enabled ? others : [...others, key] });
                },
              }}
            />
          </TabsContent>

          <TabsContent value="body" className="h-full m-0 p-0 outline-none flex flex-col">
            <RequestBodyEditor
              bodyType={bodyType}
              setBodyType={setBodyType}
              bodyValue={requestBodyValue}
              setBodyValue={setRequestBodyValue}
              tabId={activeTab.id}
            />
          </TabsContent>

          <TabsContent value="scripts" className="h-full m-0 outline-none">
            <div className="flex h-full overflow-hidden">
              <aside className="w-44 shrink-0 border-r border-pm-border bg-pm-bg flex flex-col">
                {[
                  { id: 'pre-request', key: 'preRequest', label: 'Pre-request' },
                  { id: 'post-response', key: 'postResponse', label: 'Post-response' }
                ].map(scriptTab => {
                  const isSelected = activeScriptTab === scriptTab.id;
                  const hasError = scriptErrors[scriptTab.key as keyof typeof scriptErrors];

                  const isActiveIndicator =
                    (scriptTab.label === 'Post-response' && hasScriptsPos) ||
                    (scriptTab.label === 'Pre-request' && hasScriptsPre);

                  return (
                    <button
                      key={scriptTab.id}
                      onClick={() => setActiveScriptTab(scriptTab.id as any)}
                      className={`
                        px-4 py-2 text-left text-[12px] transition-colors flex items-center justify-between cursor-pointer
                        ${isSelected 
                          ? 'bg-pm-hover text-pm-text font-semibold border-r-2 border-[#256cef]'
                          : 'text-pm-text-muted hover:text-pm-text-secondary'}
                      `}
                    >
                      <span>{scriptTab.label}</span>
                      {(isActiveIndicator || hasError) && (
                        <span
                          className={
                            hasError
                              ? 'flex h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)]'
                              : 'w-[5px] h-[5px] rounded-full bg-[#10b981]'
                          }
                          title={hasError ? 'Script error' : undefined}
                        />
                      )}
                    </button>
                  );
                })}
              </aside>

              <div className="flex flex-col flex-1 bg-pm-bg overflow-hidden">
                <div className="h-9 shrink-0 flex items-center justify-end px-2 border-b border-pm-border/70">
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer outline-none"
                      >
                        <Plus size={12} />
                        Snippets
                        <ChevronDown size={12} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64 bg-pm-surface border border-white/[0.06] rounded-xl p-1 max-h-80 overflow-y-auto">
                      {TEST_SNIPPETS.map(snippet => (
                        <DropdownMenuItem
                          key={snippet.label}
                          onClick={() => handleInsertSnippet(snippet.code)}
                          className="rounded-lg text-xs cursor-pointer py-2 px-2.5 outline-none focus:bg-pm-hover"
                        >
                          {snippet.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="flex-1 relative">
                  <CodeEditor
                    key={`${activeTab.id}-${activeScriptTab}`}
                    value={currentScriptValue}
                    onChange={handleScriptChange}
                    language="javascript"
                    onMount={handleScriptEditorMount}
                  />

                  {/* ── Dica "Ctrl+Space to create a variable" ao selecionar texto ── */}
                  {scriptSelectionHint &&
                    createPortal(
                      <div
                        style={{ left: scriptSelectionHint.x, top: scriptSelectionHint.y + 4 }}
                        className="fixed z-[99999] flex items-center gap-1 rounded-md border border-pm-border bg-pm-surface px-1.5 py-1 font-sans text-[10px] text-pm-text-muted shadow-[0_6px_18px_rgba(0,0,0,0.5)] pointer-events-none animate-in fade-in zoom-in-95 duration-100"
                      >
                        <kbd className="rounded border border-pm-border bg-pm-hover px-1 py-[1px] font-mono text-[9px] text-pm-text">
                          {isMacPlatform ? '⌘' : 'Ctrl'}
                        </kbd>
                        <span>+</span>
                        <kbd className="rounded border border-pm-border bg-pm-hover px-1 py-[1px] font-mono text-[9px] text-pm-text">
                          Space
                        </kbd>
                        <span className="ml-0.5">to create a variable</span>
                      </div>,
                      document.body
                    )}
                </div>

                {activeScriptTab === 'pre-request' ? (
                  activeTab.scripts?.preRequestError && (
                    <div className="h-32 border-t border-red-900/30 bg-[#1a1010] p-3 overflow-y-auto font-mono text-[11px]">
                      <div className="text-red-500 font-bold mb-1 italic">› Pre-request Error:</div>
                      <div className="text-pm-text-secondary">{activeTab.scripts.preRequestLog}</div>
                    </div>
                  )
                ) : (
                  activeTab.scripts?.postResponseError && (
                    <div className="h-32 border-t border-red-900/30 bg-[#1a1010] p-3 overflow-y-auto font-mono text-[11px]">
                      <div className="text-red-500 font-bold mb-1 italic">› Post-response Error:</div>
                      <div className="text-pm-text-secondary">{activeTab.scripts.postResponseLog}</div>
                    </div>
                  )
                )}
              </div>
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}


