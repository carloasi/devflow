'use client'

import React, {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef
} from 'react'

import { Environment } from '@/app/types/Environment'
import { isBlankValue, sanitizeVariableHistory } from '@/lib/variableHistory'

interface EnvironmentContextType {
  environments: Environment[]
  selectedEnvId: string | null
  activeEnv: Environment | undefined
  envVariables: Record<string, string>
  setEnvironments: React.Dispatch< 
    React.SetStateAction<Environment[]>
  >
  setSelectedEnvId: (id: string | null) => void
  importEnvironment: (env: Environment) => void
  updateEnvironment: (env: Environment) => void
  deleteEnvironment: (id: string) => void
  cloneEnvironment: (id: string) => void
  patchEnvironmentVariables: (
    envId: string,
    previousEnvMap: Record<string, string>,
    currentEnvMap: Record<string, string>
  ) => void
  replaceVariables: (text: string) => string
  markEnvironmentSynced: (envId: string) => void
  // ── Histórico de valores, GLOBAL por nome de variável ───────────────────
  // Indexado só pelo nome, e não por environment: a mesma variável costuma
  // existir em vários ambientes (dev/stg/prd), e guardar por ambiente fazia o
  // histórico "sumir" ao trocar de um pro outro, justamente quando ele é mais
  // útil — comparar e recuperar o valor que estava no outro ambiente.
  getPreviousVariableValue: (varKey: string) => string | undefined
  recordPreviousVariableValue: (varKey: string, value: string) => void
  seedPreviousVariableValueIfMissing: (varKey: string, value: string) => void
  // Lista das últimas atualizações de valor de uma variável (mais recente
  // primeiro, no máximo 5) — usado pelos popovers de edição rápida pra
  // mostrar um histórico em vez de só o valor anterior.
  getVariableValueHistory: (varKey: string) => string[]
  removeVariableValueFromHistory: (varKey: string, value: string) => void
  clearVariableValueHistory: (varKey: string) => void
}

const EnvironmentContext =
  createContext<EnvironmentContextType | undefined>(undefined)

// Quantidade máxima de valores anteriores guardados por variável — pedido do
// usuário: manter só as 5 últimas atualizações (mais recente primeiro).
const MAX_VARIABLE_HISTORY = 5

// O histórico é conveniência de edição, não dado sincronizado: fica local e
// nunca sobe pro GitHub junto com o environment.
const VARIABLE_HISTORY_KEY = 'devflow_variable_value_history'

export function EnvironmentProvider({
  children
}: {
  children: React.ReactNode
}) {
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [selectedEnvId, setSelectedEnvIdState] = useState<string | null>(null)
  // varKey -> lista de valores anteriores, mais recente primeiro (no máximo
  // MAX_VARIABLE_HISTORY entradas). Sem separação por ambiente: ver o
  // comentário do tipo do contexto.
  const [variableHistory, setVariableHistory] = useState<Record<string, string[]>>({})
  // Só depois de ler o que estava salvo é que faz sentido gravar — sem esse
  // controle, o primeiro render (com o estado ainda vazio) sobrescreveria o
  // histórico no disco antes de a leitura terminar.
  const historyLoadedRef = useRef(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(VARIABLE_HISTORY_KEY)
      // Limpa na leitura, e não só na gravação: quem já usou o app tem
      // entradas vazias salvas, e elas não sairiam sozinhas — restauram um
      // valor vazio por cima do atual, que é o oposto do que o histórico
      // serve.
      if (raw) setVariableHistory(sanitizeVariableHistory(JSON.parse(raw)))
    } catch (err) {
      console.log('Falha ao ler o histórico de variáveis:', err)
    } finally {
      historyLoadedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!historyLoadedRef.current) return
    try {
      localStorage.setItem(VARIABLE_HISTORY_KEY, JSON.stringify(variableHistory))
    } catch (err) {
      console.log('Falha ao salvar o histórico de variáveis:', err)
    }
  }, [variableHistory])
  const activeEnv = useMemo(() => {
    if (!selectedEnvId) return undefined
    return environments.find(env => env.id === selectedEnvId)
  }, [environments, selectedEnvId])

  const envVariables = useMemo(() => {
    if (!activeEnv) return {}

    return activeEnv.values.reduce((acc, v) => {
      if (v.enabled && v.key) {
        acc[v.key] = String(v.value)
      }
      return acc
    }, {} as Record<string, string>)
  }, [activeEnv?.values])

  const setSelectedEnv = useCallback((id: string | null) => {
    setSelectedEnvIdState(id)
    // A gravação em localStorage que existia aqui era morta: nada lia a chave.
    // Quem persiste a environment ativa é o activeEnvironmentStore, por
    // workspace e em arquivo próprio — e é ele que o AppLayout consulta ao
    // trocar de workspace.
  }, [])

  const deleteEnvironment = useCallback((id: string) => {
    setEnvironments(prev => prev.filter(env => env.id !== id))

    if (selectedEnvId === id) {
      setSelectedEnv(null)
    }
  }, [selectedEnvId, setSelectedEnv])

const updateEnvironment = useCallback((updatedEnv: Environment) => {
  setEnvironments(prev =>
    prev.map(env =>
      env.id === updatedEnv.id
        ? { ...updatedEnv, values: [...updatedEnv.values], isDirty: true }
        : env
    )
  )
}, [])

// Mesmo bug que o syncEnvToGlobal do AppLayout (ver comentário lá):
// reconstruir `values` do zero a partir de Object.entries(envMap) perdia
// duplicatas desabilitadas, id, description e type em toda execução de
// script no Collection Runner. Agora só a entrada habilitada de cada key é
// alterada/removida, preservando o resto do array intocado.
const patchEnvironmentVariables = useCallback(
  (envId: string, previousEnvMap: Record<string, string>, currentEnvMap: Record<string, string>) => {
    setEnvironments(prev =>
      prev.map(env => {
        if (env.id !== envId) return env

        const nextValues = [...env.values]

        Object.keys(previousEnvMap).forEach((key) => {
          if (key in currentEnvMap) return
          const idx = nextValues.findIndex(v => v.key === key && v.enabled)
          if (idx !== -1) nextValues.splice(idx, 1)
        })

        Object.entries(currentEnvMap).forEach(([key, value]) => {
          if (previousEnvMap[key] === value) return

          const enabledIdx = nextValues.findIndex(v => v.key === key && v.enabled)
          if (enabledIdx !== -1) {
            nextValues[enabledIdx] = { ...nextValues[enabledIdx], value: String(value) }
            return
          }

          const anyIdx = nextValues.findIndex(v => v.key === key)
          if (anyIdx !== -1) {
            nextValues[anyIdx] = { ...nextValues[anyIdx], value: String(value), enabled: true }
            return
          }

          nextValues.push({
            id: crypto.randomUUID(),
            key,
            value: String(value),
            type: 'default',
            enabled: true,
            description: '',
          })
        })

        return {
          ...env,
          values: nextValues
          // sem isDirty aqui de propósito
        }
      })
    )
  },
  []
)

const markEnvironmentSynced = useCallback((envId: string) => {
  setEnvironments(prev =>
    prev.map(env => env.id === envId ? { ...env, isDirty: false } : env)
  )
}, [])

  const replaceVariables = useCallback(
    (text: string): string => {
      if (!text) return text

      let result = text

      Object.entries(envVariables).forEach(([key, value]) => {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(`{{\\s*${escapedKey}\\s*}}`, 'g')

        result = result.replace(regex, String(value))
      })

      return result
    },
    [envVariables]
  )

  const importEnvironment = useCallback((env: Environment) => {
    setEnvironments(prev => [...prev, env])
    setSelectedEnv(env.id)
  }, [setSelectedEnv])

  // Duplica um ambiente inteiro (valores + cor), gerando novos ids pra tudo.
  // O clone nasce isDirty:true, porque ainda não existe no GitHub.
  const cloneEnvironment = useCallback((id: string) => {
    setEnvironments(prev => {
      const source = prev.find(env => env.id === id)
      if (!source) return prev

      const clone: Environment = {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} (copy)`,
        values: source.values.map(v => ({ ...v, id: crypto.randomUUID() })),
        isDirty: true,
      }

      return [...prev, clone]
    })
  }, [])

  // ── Histórico compartilhado ────────────────────────────────────────────

  // Valor anterior mais recente — mantido pra compatibilidade com quem só
  // precisa de um único valor (ex: comparar "mudou ou não").
  const getPreviousVariableValue = useCallback((varKey: string): string | undefined => {
    return variableHistory[varKey]?.[0]
  }, [variableHistory])

  const getVariableValueHistory = useCallback((varKey: string): string[] => {
    return variableHistory[varKey] ?? []
  }, [variableHistory])

  const recordPreviousVariableValue = useCallback((varKey: string, value: string) => {
    if (!varKey || isBlankValue(value)) return
    setVariableHistory(prev => {
      const existing = prev[varKey] ?? []
      // Se o valor já está em algum lugar da lista, não salva de novo — do
      // contrário ele entraria duplicado na frente e empurraria pra fora um
      // valor distinto que ainda não tinha aparecido (pedido do usuário: não
      // sobrescrever os outros registros por causa de um valor repetido).
      if (existing.includes(value)) return prev

      // Novo valor entra na frente (mais recente primeiro); corta em 5.
      return { ...prev, [varKey]: [value, ...existing].slice(0, MAX_VARIABLE_HISTORY) }
    })
  }, [])

  // Remove um valor específico do histórico da variável.
  const removeVariableValueFromHistory = useCallback((varKey: string, value: string) => {
    setVariableHistory(prev => {
      const existing = prev[varKey]
      if (!existing) return prev
      const nextList = existing.filter(v => v !== value)
      if (nextList.length === existing.length) return prev
      return { ...prev, [varKey]: nextList }
    })
  }, [])

  // Zera o histórico inteiro daquela variável (não mexe no valor atual dela).
  const clearVariableValueHistory = useCallback((varKey: string) => {
    setVariableHistory(prev => {
      if (!prev[varKey]) return prev
      return { ...prev, [varKey]: [] }
    })
  }, [])

  const seedPreviousVariableValueIfMissing = useCallback((varKey: string, value: string) => {
    if (!varKey || isBlankValue(value)) return
    setVariableHistory(prev => {
      if (prev[varKey] !== undefined) return prev
      return { ...prev, [varKey]: [value] }
    })
  }, [])

  useEffect(() => {
  setEnvironments(prev => {
    let changed = false
    const next = prev.map(env => {
      const values = env.values.map(v => {
        if (v.id) return v
        changed = true
        return { ...v, id: crypto.randomUUID() }
      })
      return changed ? { ...env, values } : env
    })
    return changed ? next : prev
  })
}, [environments])

  return (
    <EnvironmentContext.Provider
      value={{
      environments,
        selectedEnvId,
        activeEnv,
        envVariables,
        setEnvironments,
        setSelectedEnvId: setSelectedEnv,
        importEnvironment,
        updateEnvironment,
        deleteEnvironment,
        cloneEnvironment,
        patchEnvironmentVariables,
        replaceVariables,
        markEnvironmentSynced,
        getPreviousVariableValue,
        recordPreviousVariableValue,
        seedPreviousVariableValueIfMissing,
        getVariableValueHistory,
        removeVariableValueFromHistory,
        clearVariableValueHistory,
      }}
    >
      {children}
    </EnvironmentContext.Provider>
  )
}

export function useEnvironment() {
  const context = useContext(EnvironmentContext)

  if (!context) {
    throw new Error('useEnvironment deve ser usado dentro de EnvironmentProvider')
  }

  return context
}

