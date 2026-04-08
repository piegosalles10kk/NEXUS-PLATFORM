import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';

export interface AIAnalysisResult {
  framework: string;
  language: string;
  suggestions: {
    port: number;
    buildCommand?: string;
    startCommand?: string;
    dockerfile?: string;
    envVars?: string[];
    workflowSteps: Array<{
      name: string;
      order: number;
      type: 'LOCAL_COMMAND' | 'REMOTE_SSH_COMMAND';
      command: string;
    }>;
  };
  description: string;
}

export class AIService {
  private genAI: GoogleGenerativeAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY || '';
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async analyzeRepository(files: string[], fileContents: Record<string, string>): Promise<AIAnalysisResult> {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY não configurada no servidor.');
    }

    const prompt = this.generatePrompt(files, fileContents);
    const models = ['gemini-2.5-pro', 'gemini-2.5-flash'];
    const maxRetries = 3;

    let lastError: any = null;

    for (const modelName of models) {
      const model = this.genAI.getGenerativeModel({ model: modelName });
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`🤖 Tentativa ${attempt}/3 com o modelo ${modelName}...`);
          const result = await model.generateContent(prompt);
          const response = await result.response;
          const text = response.text();

          // Clean up the response if it contains markdown code blocks
          const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
          
          try {
            return JSON.parse(jsonStr) as AIAnalysisResult;
          } catch (err) {
            console.error(`Falha ao parsear reposta JSON do modelo ${modelName}:`, text);
            throw new Error('Resposta inváida da IA.');
          }
        } catch (err: any) {
          lastError = err;
          console.warn(`⚠️ Erro na tentativa ${attempt} do modelo ${modelName}:`, err.message || err);
          
          // Wait briefly before retrying same model
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
    }

    throw new Error(`A IA falhou após todas as tentativas extras. Último erro: ${lastError?.message || 'Desconhecido'}`);
  }

  private generatePrompt(files: string[], fileContents: Record<string, string>): string {
    return `
      Você é um especialista em DevOps e Cloud. Analise os seguintes arquivos e a estrutura de um repositório Git para sugerir a melhor configuração de deploy no Nexus Platform.

      Estrutura de Arquivos:
      ${files.join('\n')}

      Conteúdo de Arquivos Chave:
      ${Object.entries(fileContents).map(([name, content]) => `--- ${name} ---\n${content}`).join('\n\n')}

      Responda APENAS em formato JSON seguindo esta estrutura:
      {
        "framework": "string",
        "language": "string",
        "suggestions": {
          "port": number,
          "buildCommand": "string (opcional)",
          "startCommand": "string (opcional)",
          "dockerfile": "string (Conteúdo completo de um Dockerfile sugerido se não existir)",
          "envVars": ["Lista de nomes de variáveis de ambiente sugeridas (ex: de .env.example)"],
          "workflowSteps": [
            { "name": "Nome do Passo", "order": 1, "type": "LOCAL_COMMAND", "command": "comando" }
          ]
        },
        "description": "Uma breve explicação do que foi detectado e por que essas configurações foram sugeridas."
      }

      Regras:
      1. Se houver um Dockerfile, não sugira um novo, use o existente para inferir a porta.
      2. Se não houver Dockerfile, gere um Dockerfile multi-stage otimizado.
      3. WorkflowSteps são apenas se necessário comandos extras pré-build (como testes ou migrações).
      4. A porta deve ser a porta interna que a aplicação ouve dentro do container.
    `;
  }
}

export const aiService = new AIService();
