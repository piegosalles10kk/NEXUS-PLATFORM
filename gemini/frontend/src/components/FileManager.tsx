import { useState, useEffect, useRef } from 'react';
import { 
  Folder, Download, Upload, Trash2, 
  Copy, Scissors, Clipboard, Search, ArrowLeft, RefreshCw,
  MoreVertical, FileText, LayoutGrid, List, FileCode, HardDrive,
  AlertCircle
} from 'lucide-react';
import api from '../services/api';

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

interface FileManagerProps {
  nodeId?: string;
  projectId?: string;
  canEdit?: boolean;
}

export default function FileManager({ nodeId, projectId, canEdit = true }: FileManagerProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [clipboard, setClipboard] = useState<{ path: string; action: 'copy' | 'cut' } | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = projectId 
        ? `/projects/${projectId}/files` 
        : `/v1/agent/nodes/${nodeId}/files`;
      const res = await api.get(url, { params: { path } });
      setEntries(res.data.data.entries || []);
      setCurrentPath(path);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao carregar arquivos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles('');
  }, [nodeId]);

  const handleFolderClick = (path: string) => {
    loadFiles(path);
  };

  const handleBack = () => {
    const parts = currentPath.split(/[/\\]/).filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    const parentPath = parts.join('/') || '/';
    loadFiles(parentPath === '/' ? '' : parentPath);
  };

  const handleDelete = async (entry: FileEntry) => {
    if (!canEdit) return;
    if (!confirm(`Tem certeza que deseja excluir ${entry.name}?`)) return;
    try {
      const url = projectId 
        ? `/projects/${projectId}/files` 
        : `/v1/agent/nodes/${nodeId}/files`;
      await api.delete(url, { params: { path: entry.path } });
      loadFiles(currentPath);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Falha ao deletar.');
    }
  };

  const handleCopy = (entry: FileEntry) => {
    setClipboard({ path: entry.path, action: 'copy' });
  };

  const handleCut = (entry: FileEntry) => {
    setClipboard({ path: entry.path, action: 'cut' });
  };

  const handlePaste = async () => {
    if (!clipboard || !canEdit) return;
    try {
      const dest = currentPath ? `${currentPath}/${clipboard.path.split(/[/\\]/).pop()}` : clipboard.path.split(/[/\\]/).pop() || '';
      const baseUrl = projectId 
        ? `/projects/${projectId}/files` 
        : `/v1/agent/nodes/${nodeId}/files`;
      
      if (clipboard.action === 'copy') {
        await api.post(`${baseUrl}/copy`, { path: clipboard.path, dest });
      } else {
        await api.post(`${baseUrl}/move`, { path: clipboard.path, dest });
        setClipboard(null);
      }
      loadFiles(currentPath);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Falha ao colar.');
    }
  };

  const handleDownload = async (entry: FileEntry) => {
    try {
      const url = projectId 
        ? `/projects/${projectId}/files/content` 
        : `/v1/agent/nodes/${nodeId}/files/read`;
      const res = await api.get(url, { params: { path: entry.path } });
      const contentB64 = res.data.data.content;
      
      const byteCharacters = atob(contentB64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      
      const blob = new Blob([byteArray], { type: 'application/octet-stream' });
      const urlBlob = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = urlBlob;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(urlBlob);
      document.body.removeChild(a);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Falha ao baixar arquivo.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit) return;
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const arrayBuffer = event.target?.result as ArrayBuffer;
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);

      try {
        const dest = currentPath ? `${currentPath}/${file.name}` : file.name;
        const isProject = !!projectId;
        const url = isProject 
          ? `/projects/${projectId}/files/content` 
          : `/v1/agent/nodes/${nodeId}/files/write`;
        
        if (isProject) {
          await api.put(url, { path: dest, content: b64 });
        } else {
          await api.post(url, { path: dest, content: b64 });
        }
        loadFiles(currentPath);
      } catch (err: any) {
        alert(err.response?.data?.message || 'Falha no upload.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const filteredEntries = entries.filter(e => e.name.toLowerCase().includes(searchQuery.toLowerCase()));

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="bg-bg-card border border-border rounded-xl overflow-hidden flex flex-col h-[700px] animate-fade-in shadow-xl">
      {/* Toolbar */}
      <div className="p-4 border-b border-border bg-bg-secondary flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button 
            onClick={handleBack}
            disabled={!currentPath || currentPath === '/'}
            className="p-2 rounded-lg hover:bg-bg-primary text-text-secondary disabled:opacity-30 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button 
            onClick={() => loadFiles(currentPath)}
            className="p-2 rounded-lg hover:bg-bg-primary text-text-secondary transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="h-6 w-px bg-border mx-1" />
          {canEdit && (
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="px-3 py-1.5 rounded-lg bg-accent/10 hover:bg-accent/20 text-accent-light text-xs font-bold flex items-center gap-2 transition-colors"
            >
              <Upload className="w-4 h-4" /> Upload
            </button>
          )}
          {canEdit && (
            <button 
              onClick={handlePaste}
              disabled={!clipboard}
              className="px-3 py-1.5 rounded-lg bg-success/10 hover:bg-success/20 text-success text-xs font-bold flex items-center gap-2 transition-colors disabled:opacity-30"
            >
              <Clipboard className="w-4 h-4" /> Colar {clipboard && `(${clipboard.action})`}
            </button>
          )}
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            className="hidden" 
          />
        </div>

        <div className="flex items-center gap-4 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted transition-colors group-focus-within:text-accent" />
            <input 
              type="text"
              placeholder="Buscar arquivos..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-primary border border-border rounded-lg pl-10 pr-4 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-all"
            />
          </div>
          <div className="flex bg-bg-primary border border-border rounded-lg p-0.5">
            <button 
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'list' ? 'bg-bg-card text-accent shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
            >
              <List className="w-4 h-4" />
            </button>
            <button 
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-bg-card text-accent shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Path Display */}
      <div className="px-4 py-2 bg-bg-primary/50 border-b border-border flex items-center gap-2 text-xs font-mono">
        <HardDrive className="w-3 h-3 text-text-muted" />
        <span className="text-text-muted">Host FS:</span>
        <span className="text-text-primary px-2 py-0.5 bg-bg-secondary rounded border border-border">{currentPath || '/'}</span>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {loading && entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-text-muted animate-pulse">
            <RefreshCw className="w-10 h-10 animate-spin opacity-20" />
            <p className="text-sm font-medium">Escaneando diretórios...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-danger">
            <AlertCircle className="w-10 h-10 opacity-50" />
            <p className="font-bold">Erro ao listar arquivos</p>
            <p className="text-sm opacity-80">{error}</p>
            <button onClick={() => loadFiles(currentPath)} className="mt-4 px-4 py-2 rounded-lg bg-danger/10 hover:bg-danger/20 text-xs font-bold transition-all">Tentar Novamente</button>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-text-muted opacity-50">
            <Folder className="w-16 h-16 stroke-1" />
            <p className="text-sm italic">Pasta vazia ou nada encontrado.</p>
          </div>
        ) : viewMode === 'list' ? (
          <div className="w-full">
            <div className="grid grid-cols-[1fr_120px_150px_100px] gap-4 px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-text-muted border-b border-border/50 mb-2">
              <span>Nome</span>
              <span>Tamanho</span>
              <span>Tipo</span>
              <span className="text-right">Ações</span>
            </div>
            <div className="space-y-1">
              {filteredEntries.sort((a, b) => Number(b.isDir) - Number(a.isDir)).map((entry) => (
                <div 
                  key={entry.path}
                  className="grid grid-cols-[1fr_120px_150px_100px] gap-4 px-4 py-2.5 rounded-lg hover:bg-accent/5 hover:border-accent/20 border border-transparent transition-all group items-center"
                >
                  <div 
                    className="flex items-center gap-3 cursor-pointer overflow-hidden"
                    onClick={() => entry.isDir ? handleFolderClick(entry.path) : null}
                  >
                    {entry.isDir ? (
                      <Folder className="w-5 h-5 text-warning shrink-0 fill-warning/20" />
                    ) : (
                      <FileText className="w-5 h-5 text-accent-light shrink-0 opacity-80" />
                    )}
                    <span className="text-sm text-text-primary font-medium truncate">{entry.name}</span>
                  </div>
                  <span className="text-xs text-text-secondary font-mono">
                    {entry.isDir ? '--' : formatSize(entry.size)}
                  </span>
                  <span className="text-[10px] text-text-muted uppercase tracking-wider font-bold">
                    {entry.isDir ? 'Diretório' : entry.name.split('.').pop() + ' File'}
                  </span>
                  <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!entry.isDir && (
                      <button onClick={() => handleDownload(entry)} className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-accent transition-colors" title="Download">
                        <Download className="w-4 h-4" />
                      </button>
                    )}
                    {canEdit && (
                      <button onClick={() => handleCopy(entry)} className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-accent transition-colors" title="Copiar">
                        <Copy className="w-4 h-4" />
                      </button>
                    )}
                    {canEdit && (
                      <button onClick={() => handleCut(entry)} className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-accent transition-colors" title="Recortar">
                        <Scissors className="w-4 h-4" />
                      </button>
                    )}
                    {canEdit && (
                      <button onClick={() => handleDelete(entry)} className="p-1.5 rounded-lg hover:bg-bg-secondary text-text-secondary hover:text-danger transition-colors" title="Deletar">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
             {filteredEntries.sort((a, b) => Number(b.isDir) - Number(a.isDir)).map((entry) => (
                <div 
                  key={entry.path}
                  className="flex flex-col items-center p-4 rounded-xl hover:bg-accent/5 border border-transparent hover:border-accent/20 transition-all group relative cursor-pointer"
                  onClick={() => entry.isDir ? handleFolderClick(entry.path) : null}
                >
                  <div className="w-16 h-16 mb-3 flex items-center justify-center relative">
                    {entry.isDir ? (
                      <Folder className="w-12 h-12 text-warning fill-warning/20 group-hover:scale-110 transition-transform" />
                    ) : (
                      <FileCode className="w-12 h-12 text-accent-light opacity-80 group-hover:scale-110 transition-transform" />
                    )}
                  </div>
                  <span className="text-xs text-text-primary text-center font-medium line-clamp-2 break-all px-2">{entry.name}</span>
                  {!entry.isDir && <span className="text-[9px] text-text-muted mt-1 font-mono uppercase">{formatSize(entry.size)}</span>}
                  
                  {/* Grid Action Overlay */}
                  <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button className="p-1 rounded-full bg-bg-card border border-border shadow-soft" onClick={(e) => { e.stopPropagation(); /* show menu */ }}>
                      <MoreVertical className="w-3 h-3" />
                    </button>
                  </div>
                </div>
             ))}
          </div>
        )}
      </div>

      <div className="px-4 py-2 border-t border-border bg-bg-secondary flex items-center justify-between text-[10px] text-text-muted font-bold tracking-widest uppercase">
        <div className="flex gap-4">
          <span>{entries.filter(e => e.isDir).length} Pastas</span>
          <span>{entries.filter(e => !e.isDir).length} Arquivos</span>
        </div>
        <div className="flex items-center gap-2">
          {clipboard && <span className="text-accent animate-pulse">Área de Transferência: {clipboard.path.split(/[/\\]/).pop()} ({clipboard.action})</span>}
        </div>
      </div>
    </div>
  );
}

