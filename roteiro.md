# CONTEXTO DE PROJETO PARA GERAÇÃO DE BACKLOG: FRONT-END NEXUS (FASE 3 - DePIN)

## 1. Visão Geral do Projeto
O **Nexus** é uma plataforma de nuvem híbrida gerida por um "Solo Founder". A aplicação possui um front-end atualizado que suporta perfeitamente o seu produto legado (CI/CD Clássico - tabela `Project`), mas agora precisa de suportar a nova malha distribuída de processamento "Uber de Hardware" (DePIN - tabela `DePINApp`). O objetivo é atualizar o front-end sem causar regressões na interface de CI/CD existente.

## 2. Stack Tecnológica
* **Framework:** React 18 (Vite) + TypeScript
* **Estilização:** Tailwind CSS 4 + Componentes customizados
* **Roteamento:** React Router DOM (v6)
* **Gráficos:** Recharts
* **Ícones:** Lucide-react
* **Requisições:** Axios (com interceptors já configurados em `api.ts`)

## 3. Estado Atual vs. Estado Desejado
* **Atualmente:** O painel (ex: `Sidebar.tsx`, `ProjectsPage.tsx`) exibe apenas as configurações de Deploy Clássico 1-para-1 (Cloud/Local).
* **Objetivo:** Adicionar uma árvore de navegação paralela e novas páginas para gerir aplicações DePIN. Estas aplicações não têm um único destino, mas sim um Enxame de execução com base no número de réplicas, estado do protocolo Raft (Líder/Seguidor) e faturação por consumo de milissegundos de CPU/RAM.

## 4. O Roteiro de Sprints (O que deve ser gerado)
Com base nestas Sprints, gere as Epics, Tasks e Sub-tasks em formato de tickets (ex: Jira/Trello), incluindo "Critérios de Aceite" técnicos.

### SPRINT 1: Fundação DePIN (Navegação e Modelos Base)
* **Objetivo:** Preparar a casca da plataforma e permitir a criação de uma `DePINApp`.
* **Arquivos-alvo:** `App.tsx`, `Sidebar.tsx`, `DePINAppsPage.tsx` (novo), `CreateDePINAppModal.tsx` (novo).
* **Regras de Negócio:**
  * O `Sidebar.tsx` deve ganhar um link separado chamado "DePIN (Enxame)".
  * A nova `DePINAppsPage.tsx` deve listar as aplicações mapeando o enum `DePINAppStatus` (PENDING, RUNNING, DEGRADED, OFFLINE).
  * O modal de criação deve enviar o payload com `name`, `slug` (para o Ingress Gateway), `executionMode` (WASM, MICROVM, AUTO) e `replicaCount`.

### SPRINT 2: Topologia do Cluster e Estado do Raft
* **Objetivo:** Fornecer observabilidade em tempo real do Enxame.
* **Arquivos-alvo:** `DePINClusterView.tsx` (novo), `AssignmentsList.tsx` (novo).
* **Regras de Negócio:**
  * A página de detalhes deve consumir os dados agregados da aplicação.
  * O componente de `Assignments` deve renderizar a relação 1-para-N da tabela `NodeAssignment`.
  * É crucial exibir visualmente (por cores ou ícones) a coluna `AssignmentRole` (LEADER, FOLLOWER, WASM_WORKER) e o `AssignmentStatus` (RUNNING, OFFLINE, MIGRATING), refletindo o consenso do cluster distribuído.

### SPRINT 3: Billing Dashboard ("Proof of Computing")
* **Objetivo:** Apresentar a interface financeira de cobrança e recebimento de créditos.
* **Arquivos-alvo:** `BillingDashboard.tsx` (novo), integração com Recharts.
* **Regras de Negócio:**
  * Criar gráficos que plotem os dados provindos dos endpoints do `billing.service.ts` (`getAppUsage` e `getNodeEarnings`).
  * As métricas cruas (`cpuMs`, `ramMbS`, `netTxBytes`) armazenadas em BigInt devem ser formatadas para exibição amigável no UI.
  * Deve exibir o Custo Total para o dono da aplicação (`totalCostUsd`) e o Lucro Líquido para o dono do hardware (`netUsd`), já deduzindo a comissão padrão de 20%.

## 5. Instruções de Saída
Gere o backlog detalhado para estas 3 Sprints. Para cada task, exija a identificação explícita do estado a ser gerenciado (ex: `useState`, *hooks* customizados) e a indicação de quais componentes do Tailwind deverão ser reaproveitados da biblioteca de UI existente para manter a consistência visual.