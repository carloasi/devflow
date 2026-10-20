// export class ScriptEngine {
//   execute(script: string, context: { env: any, request?: any, response?: any }) {
//     // Criamos o objeto 'pm' que o usuário do Postman espera
//     const pm = {
//       environment: {
//         get: (key: string) => context.env[key],
//         set: (key: string, value: any) => {
//           context.env[key] = value;