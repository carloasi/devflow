export interface EnvironmentValue {
  id?: string;
  key: string;
  value: string;
  type: string;
  enabled: boolean;
  description?: string;
}

export interface Environment {
  id: string;
  name: string;
  values: EnvironmentValue[];
  color?: number;
  _postman_variable_scope?: string;
  isDirty?: boolean; // true quando há alterações não sincronizadas com o GitHub
}