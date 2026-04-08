import React, { useState, useEffect } from 'react';
import { Activity, Plus, Trash2, Play, Pause, Search, RefreshCw, Layers, Globe, Zap, Settings, Radio } from 'lucide-react';
import { GatewayService, GatewayRoute } from '../services/gateway.service';
import api from '../services/api';

interface Node {
  id: string;
  name: string;
  status: 'ONLINE' | 'OFFLINE' | 'UPDATING';
  os: string;
  ipAddress: string | null;
}

const GatewayPage: React.FC = () => {
  const [routes, setRoutes] = useState<GatewayRoute[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalTab, setModalTab] = useState<'local' | 'public' | 'tunnel'>('local');
  const [isScanning, setIsScanning] = useState(false);
  const [activePorts, setActivePorts] = useState<number[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [isScanningAgent, setIsScanningAgent] = useState(false);
  const [agentActivePorts, setAgentActivePorts] = useState<number[]>([]);

  const [formData, setFormData] = useState({
    name: '',
    routePath: '',
    targetUrl: '',
    checkPort: 0,
    isActive: true,
    isTunnelled: false,
    tunnelNodeId: '',
  });

  const fetchRoutes = async () => {
    try {
      const data = await GatewayService.getRoutes();
      setRoutes(data);
    } catch (error) {
      console.error('Error fetching routes:', error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  const fetchNodes = async () => {
    try {
      const res = await api.get('/v1/agent/nodes');
      setNodes(res.data?.data?.nodes ?? []);
    } catch (err) {
      console.error('Error fetching nodes:', err);
    }
  };

  useEffect(() => {
    fetchRoutes();
    fetchNodes();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload: any = { ...formData };
      // For local-mode routes, clear tunnel fields
      if (modalTab !== 'tunnel') {
        payload.isTunnelled = false;
        payload.tunnelNodeId = null;
      }
      await GatewayService.createRoute(payload);
      fetchRoutes();
      setShowModal(false);
      resetForm();
    } catch (error: any) {
      alert(error.response?.data?.message || 'Erro ao criar rota');
    }
  };

  const resetForm = () => {
    setFormData({ name: '', routePath: '', targetUrl: '', checkPort: 0, isActive: true, isTunnelled: false, tunnelNodeId: '' });
  };

  const selectPort = (port: number) => {
    setFormData({
      ...formData,
      name: `Serviço na porta ${port}`,
      targetUrl: '',
      checkPort: port,
      routePath: '',
      isTunnelled: false,
      tunnelNodeId: '',
    });
    setModalTab('local');
    setShowModal(true);
  };

  const toggleRoute = async (route: GatewayRoute) => {
    try {
      await GatewayService.updateRoute(route.id, { isActive: !route.isActive });
      fetchRoutes();
    } catch (error) {
      console.error('Error toggling route:', error);
    }
  };

  const deleteRoute = async (id: string) => {
    if (!window.confirm('Deseja remover esta rota?')) return;
    try {
      await GatewayService.deleteRoute(id);
      fetchRoutes();
    } catch (error) {
      console.error('Error deleting route:', error);
    }
  };

  const scanPorts = async () => {
    setIsScanning(true);
    setActivePorts([]);
    try {
      const { activePorts } = await GatewayService.discoverPorts();
      setActivePorts(activePorts);
    } catch (error) {
      console.error('Error scanning ports:', error);
    } finally {
      setIsScanning(false);
    }
  };

  const scanAgentPorts = async () => {
    if (!formData.tunnelNodeId) return;
    setIsScanningAgent(true);
    setAgentActivePorts([]);
    try {
      const res = await api.get(`/v1/agent/nodes/${formData.tunnelNodeId}/scan-ports`);
      setAgentActivePorts(res.data?.data?.ports ?? []);
    } catch (error) {
      console.error('Error scanning agent ports:', error);
      alert('Falha ao escanear portas do agente. Verifique se ele está online.');
    } finally {
      setIsScanningAgent(false);
    }
  };

  const openModal = (tab: 'local' | 'public' | 'tunnel') => {
    resetForm();
    setModalTab(tab);
    setShowModal(true);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center bg-zinc-900/50 p-6 rounded-2xl border border-zinc-800 backdrop-blur-xl">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent tracking-tight">API Gateway</h1>
          <p className="text-zinc-400 mt-1">Proxy reverso inteligente com descoberta automática de serviços</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => { setIsRefreshing(true); fetchRoutes(); }}
            className="p-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-all border border-zinc-700 text-zinc-300"
          >
            <RefreshCw size={20} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => openModal('local')}
            className="flex items-center gap-2 px-5 py-3 bg-blue-600 hover:bg-blue-500 rounded-xl transition-all font-semibold shadow-lg shadow-blue-500/20"
          >
            <Plus size={20} />
            Nova Rota
          </button>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left Column: Stats and Scanner */}
        <div className="lg:col-span-1 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 p-5 rounded-2xl">
              <div className="flex items-center gap-2 text-zinc-500 mb-2">
                <Activity size={16} className="text-green-500" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Gateway Status</span>
              </div>
              <div className="text-xl font-bold text-zinc-100 italic uppercase">Ativo</div>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 p-5 rounded-2xl">
              <div className="flex items-center gap-2 text-zinc-500 mb-2">
                <Layers size={16} className="text-blue-500" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Rotas Online</span>
              </div>
              <div className="text-xl font-bold text-zinc-100">{routes.filter(r => r.isActive).length} / {routes.length}</div>
            </div>
          </div>

          <div className="bg-gradient-to-br from-indigo-900/40 to-zinc-900 border border-indigo-500/20 p-6 rounded-2xl shadow-xl">
            <div className="flex justify-between items-start mb-6">
              <div className="flex gap-3">
                <div className="p-2 bg-indigo-500/10 rounded-lg">
                  <Search size={20} className="text-indigo-400" />
                </div>
                <div>
                  <h3 className="font-bold text-zinc-100">Scanner Local</h3>
                  <p className="text-xs text-zinc-500">Monitorando portas 1-5000</p>
                </div>
              </div>
              <button
                onClick={scanPorts}
                disabled={isScanning}
                className={`p-2 rounded-lg transition-all ${isScanning ? 'bg-zinc-800 text-zinc-600' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'}`}
              >
                <RefreshCw size={18} className={isScanning ? 'animate-spin' : ''} />
              </button>
            </div>

            <div className="min-h-[200px] flex flex-col items-center justify-center border-2 border-dashed border-zinc-800 rounded-xl p-4">
              {isScanning ? (
                <div className="text-center">
                  <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-xs text-zinc-400 font-medium animate-pulse text-indigo-300">Vasculhando portas do Host...</p>
                </div>
              ) : activePorts.length > 0 ? (
                <div className="w-full grid grid-cols-3 gap-2">
                  {activePorts.map(port => (
                    <button
                      key={port}
                      onClick={() => selectPort(port)}
                      className="p-2 bg-zinc-800 hover:bg-indigo-600/20 border border-zinc-700 hover:border-indigo-500/40 rounded-lg text-xs font-mono text-zinc-300 transition-all flex flex-col items-center gap-1"
                    >
                      <Zap size={10} className="text-amber-400" />
                      {port}
                    </button>
                  ))}
                  <div className="col-span-3 mt-4 flex justify-between items-center px-1">
                    <span className="text-[10px] text-zinc-500 uppercase font-bold">{activePorts.length} portas livres</span>
                    <button onClick={() => setActivePorts([])} className="text-[10px] text-zinc-400 hover:text-red-400 font-bold uppercase transition-colors">Limpar</button>
                  </div>
                </div>
              ) : (
                <div className="text-center opacity-40">
                  <Search size={32} className="mx-auto mb-2 text-zinc-600" />
                  <p className="text-xs font-medium">Nenhum serviço detectado</p>
                  <p className="text-[10px] mt-1">Inicie o scan para encontrar portas</p>
                </div>
              )}
            </div>
          </div>

          {/* Tunnel shortcut card */}
          <div
            onClick={() => openModal('tunnel')}
            className="bg-gradient-to-br from-violet-900/30 to-zinc-900 border border-violet-500/20 p-5 rounded-2xl shadow-xl cursor-pointer hover:border-violet-400/40 transition-all group"
          >
            <div className="flex gap-3 items-center">
              <div className="p-2 bg-violet-500/10 rounded-lg group-hover:bg-violet-500/20 transition-all">
                <Radio size={20} className="text-violet-400" />
              </div>
              <div>
                <h3 className="font-bold text-zinc-100 text-sm">Tunnel via Agente</h3>
                <p className="text-[11px] text-zinc-500 mt-0.5">Exponha serviços em redes privadas</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Routes List */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-zinc-800 bg-zinc-900/50 flex justify-between items-center">
              <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                <Settings size={14} /> Rotas Configuradas
              </h3>
              <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-full font-bold border border-blue-500/20">PROXY ONLINE</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-zinc-950/50 text-zinc-500 uppercase text-[10px] font-bold border-b border-zinc-800">
                  <tr>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Nome / ID</th>
                    <th className="px-6 py-4">Endpoint</th>
                    <th className="px-6 py-4">Destino (Target)</th>
                    <th className="px-6 py-4 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {isLoading ? (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-zinc-500">Caregando rotas...</td></tr>
                  ) : routes.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-20 text-center">
                        <Globe size={40} className="mx-auto mb-4 text-zinc-800" />
                        <p className="text-zinc-500 font-medium">Nenhuma rota configurada</p>
                        <button
                          onClick={() => setShowModal(true)}
                          className="mt-4 text-xs font-bold text-blue-400 hover:text-blue-300 underline underline-offset-4"
                        >
                          Crie sua primeira rota agora
                        </button>
                      </td>
                    </tr>
                  ) : routes.map(route => (
                    <tr key={route.id} className="hover:bg-zinc-800/30 transition-colors group">
                      <td className="px-6 py-4">
                        <div className={`w-3 h-3 rounded-full ${route.isActive ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-zinc-700'}`} />
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-bold text-zinc-100">{route.name}</div>
                        <div className="text-[10px] text-zinc-500 font-mono mt-1">{route.id.split('-')[0]}</div>
                      </td>
                      <td className="px-6 py-4">
                        <a
                          href={`${window.location.origin}${route.routePath}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1 bg-zinc-800 hover:bg-blue-600/20 rounded-lg text-blue-300 font-mono text-[11px] border border-zinc-700 hover:border-blue-500/50 font-bold tracking-tight transition-all block w-max cursor-pointer"
                          title="Abrir no navegador"
                        >
                          {route.routePath}
                        </a>
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-xs text-zinc-300 font-mono tracking-tight max-w-[180px] truncate" title={route.targetUrl}>
                          {route.targetUrl}
                        </div>
                        <div className="flex items-center gap-1 mt-1">
                          {route.isTunnelled ? (
                            <span className="text-[9px] text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded font-bold uppercase flex items-center gap-1">
                              <Radio size={8} /> Tunnel
                            </span>
                          ) : route.checkPort > 0 ? (
                            <span className="text-[9px] text-indigo-400 bg-indigo-500/10 px-1 rounded font-bold uppercase">Local Service</span>
                          ) : (
                            <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1 rounded font-bold uppercase">Public Route</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-1 text-zinc-400 opacity-20 group-hover:opacity-100 transition-all">
                          <button onClick={() => toggleRoute(route)} className={`p-2 hover:bg-zinc-700 rounded-lg transition-all ${route.isActive ? 'text-amber-400' : 'text-green-400'}`}>
                            {route.isActive ? <Pause size={16} /> : <Play size={16} />}
                          </button>
                          <button onClick={() => deleteRoute(route.id)} className="p-2 hover:bg-zinc-700 hover:text-red-400 rounded-lg transition-all">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Modal Nova Rota */}
      {showModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Tabs */}
            <div className="flex border-b border-zinc-800">
              <button
                onClick={() => { setModalTab('local'); resetForm(); }}
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-all ${modalTab === 'local' ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-400/5' : 'text-zinc-500 hover:bg-zinc-800'}`}
              >
                Serviço Local
              </button>
              <button
                onClick={() => { setModalTab('public'); resetForm(); }}
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-all ${modalTab === 'public' ? 'text-blue-400 border-b-2 border-blue-400 bg-blue-400/5' : 'text-zinc-500 hover:bg-zinc-800'}`}
              >
                Rota Pública
              </button>
              <button
                onClick={() => { setModalTab('tunnel'); resetForm(); setFormData(f => ({ ...f, isTunnelled: true })); }}
                className={`flex-1 py-4 text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-1 ${modalTab === 'tunnel' ? 'text-violet-400 border-b-2 border-violet-400 bg-violet-400/5' : 'text-zinc-500 hover:bg-zinc-800'}`}
              >
                <Radio size={12} /> Tunnel
              </button>
            </div>

            <div className="p-8">
              <h2 className="text-xl font-bold text-zinc-100 mb-6 flex items-center gap-3">
                {modalTab === 'local' ? <Zap className="text-amber-400" /> : modalTab === 'tunnel' ? <Radio className="text-violet-400" /> : <Globe className="text-emerald-400" />}
                {modalTab === 'local' ? 'Configurar Serviço Local' : modalTab === 'tunnel' ? 'Tunnel via Agente' : 'Criar Rota Externa'}
              </h2>

              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Nome da Rota</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all outline-none placeholder:text-zinc-700"
                    placeholder="Ex: API Financeira"
                    required
                  />
                </div>

                {modalTab === 'local' && (
                  <div>
                    <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Porta do Host</label>
                    <input
                      type="number"
                      value={formData.checkPort || ''}
                      onChange={e => setFormData({ ...formData, checkPort: parseInt(e.target.value) || 0 })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all outline-none"
                      placeholder="Ex: 3000"
                      required
                    />
                    <p className="text-[10px] text-zinc-600 mt-1 italic">Dica: Use o scanner lateral para encontrar portas abertas automaticamente.</p>
                  </div>
                )}

                {modalTab === 'public' && (
                  <>
                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Endpoint Público</label>
                      <input
                        type="text"
                        value={formData.routePath}
                        onChange={e => setFormData({ ...formData, routePath: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all outline-none placeholder:text-zinc-700"
                        placeholder="Ex: /meu-site"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">URL de Destino (Externa)</label>
                      <input
                        type="text"
                        value={formData.targetUrl}
                        onChange={e => setFormData({ ...formData, targetUrl: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all outline-none placeholder:text-zinc-700"
                        placeholder="Ex: https://api.google.com"
                        required
                      />
                    </div>
                  </>
                )}

                {modalTab === 'tunnel' && (
                  <>
                    {/* Tunnel info banner */}
                    <div className="flex items-start gap-2 bg-violet-500/5 border border-violet-500/20 rounded-xl p-3">
                      <Radio size={14} className="text-violet-400 mt-0.5 shrink-0" />
                      <p className="text-[11px] text-zinc-400 leading-relaxed">
                        O tráfego é encaminhado pelo WebSocket do agente. Ideal para serviços em redes privadas sem IP público.
                      </p>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Nó Agente</label>
                      <select
                        value={formData.tunnelNodeId}
                        onChange={e => setFormData({ ...formData, tunnelNodeId: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 text-sm focus:outline-none focus:ring-1 focus:ring-violet-500 transition-all outline-none"
                        required
                      >
                        <option value="">Selecione um agente online...</option>
                        {nodes.filter(n => n.status === 'ONLINE').map(n => (
                          <option key={n.id} value={n.id}>
                            {n.name} — {n.os} {n.ipAddress ? `(${n.ipAddress})` : ''}
                          </option>
                        ))}
                      </select>
                      {formData.tunnelNodeId && (
                        <button
                          type="button"
                          onClick={scanAgentPorts}
                          disabled={isScanningAgent}
                          className="mt-2 flex items-center gap-2 text-[10px] font-bold text-violet-400 hover:text-violet-300 transition-colors uppercase tracking-wider disabled:opacity-50"
                        >
                          <RefreshCw size={12} className={isScanningAgent ? 'animate-spin' : ''} />
                          {isScanningAgent ? 'Escaneando Agente...' : 'Descobrir serviços no agente'}
                        </button>
                      )}
                      {nodes.filter(n => n.status === 'ONLINE').length === 0 && (
                        <p className="text-[10px] text-amber-500 mt-1">Nenhum agente online no momento.</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">Endpoint Público (prefixo)</label>
                      <input
                        type="text"
                        value={formData.routePath}
                        onChange={e => setFormData({ ...formData, routePath: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-violet-500 transition-all outline-none placeholder:text-zinc-700"
                        placeholder="Ex: /minha-api"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">URL Local no Agente</label>
                      <input
                        type="text"
                        value={formData.targetUrl}
                        onChange={e => setFormData({ ...formData, targetUrl: e.target.value })}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-violet-500 transition-all outline-none placeholder:text-zinc-700"
                        placeholder="Ex: http://localhost:8080"
                        required
                      />
                      {agentActivePorts.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2 animate-in fade-in slide-in-from-top-1 duration-300">
                          {agentActivePorts.map(port => (
                            <button
                              key={port}
                              type="button"
                              onClick={() => {
                                setFormData({ ...formData, targetUrl: `http://localhost:${port}` });
                                setAgentActivePorts([]); // hide after selection
                              }}
                              className="px-2 py-1 bg-violet-600/10 hover:bg-violet-600/20 border border-violet-500/20 rounded-md text-[10px] font-mono text-violet-300 transition-all flex items-center gap-1"
                            >
                              <Zap size={8} className="text-amber-400" />
                              {port}
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="text-[10px] text-zinc-600 mt-1 italic">Dica: Use o botão de descoberta acima para encontrar portas automágicamente.</p>
                    </div>
                  </>
                )}

                <div className="flex gap-3 pt-6">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 px-4 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl font-bold text-xs uppercase tracking-widest transition-all border border-zinc-700"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className={`flex-1 px-4 py-3 text-white rounded-xl font-bold text-xs uppercase tracking-widest transition-all shadow-lg ${
                      modalTab === 'tunnel'
                        ? 'bg-violet-600 hover:bg-violet-500 shadow-violet-500/20'
                        : 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/20'
                    }`}
                  >
                    Salvar Rota
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GatewayPage;
