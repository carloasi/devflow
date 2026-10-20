export const parseVariablesInText = (text: string, activeEnvValues: EnvValue[]) => {
  const regex = /\{\{([^}]+)\}\}/g;
  const matches: { raw: string; key: string; value: string; found: boolean }[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0]; // {{urlResources}}
    const key = match[1].trim(); // urlResources
    
    const envVar = activeEnvValues.find(v => v.key === key && v.enabled);
    
    matches.push({
      raw,
      key,
      value: envVar ? envVar.value : 'Não encontrada',
      found: !!envVar
    });
  }

  return matches;
};