import { Tab } from "@/app/types/Tab";
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getPathParameterValue(
  dataList: any[],
  activeTabId: string,
  paramKey: string
): string | null {

  if (!Array.isArray(dataList)) return null;

  const targetId = String(activeTabId ?? '')
    .replace(/^"|"$/g, '')
    .trim()
    .toLowerCase();

  //console.log("targetId:", targetId);
  //console.log("dataList:", dataList);

  const activeTab = dataList.find((tab) => {
    const tabId = String(tab?.id ?? '')
      .replace(/^"|"$/g, '')
      .trim()
      .toLowerCase();

    return tabId === targetId;
  });

  //console.log("activeTab:", activeTab);

  if (!activeTab || !Array.isArray(activeTab.params)) {
    return null;
  }

  const targetParam = activeTab.params.find(
    (p: any) =>
      String(p?.key ?? '').toLowerCase() ===
      String(paramKey ?? '').toLowerCase()
  );

  return targetParam?.value ?? null;
}

// A CHAVE do localStorage mantém o nome antigo de propósito: ela é um
// contrato com dados já gravados na máquina do usuário por versões
// anteriores. Renomear a chave não renomeia o que está no disco — só faria a
// leitura devolver vazio.
const LEGACY_TABS_KEY = 'postman_clone_tabs';

export function getLegacyStoredTabs(): Tab[] {
  try {
    // 1. Busca a string crua que está no LocalStorage
    const rawTabs = localStorage.getItem(LEGACY_TABS_KEY);

    if (!rawTabs) {
      return [];
    }

    // 2. Transforma a string JSON de volta num Array de objetos do JavaScript
    const parsedData = JSON.parse(rawTabs);

    // 3. Garante que o retorno seja sempre um array válido
    return Array.isArray(parsedData) ? parsedData : [];
  } catch (error) {
    console.error(`Erro ao fazer parse de ${LEGACY_TABS_KEY}:`, error);
    return [];
  }
}