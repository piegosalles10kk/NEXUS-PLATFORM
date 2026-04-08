import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Responsive, useContainerWidth } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { io } from 'socket.io-client';

import { Plus, LayoutDashboard, Loader2, Settings2 } from 'lucide-react';
import { BaseWidget } from '../components/dashboard/widgets/BaseWidget';
import { ProjectMiniWidget } from '../components/dashboard/widgets/ProjectMiniWidget';
import { ServerCardWidget } from '../components/dashboard/widgets/ServerCardWidget';
import { AddWidgetModal } from '../components/dashboard/AddWidgetModal';

interface Widget {
  id: string;
  type: string;
  title: string;
  settings: any;
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function DashboardPage() {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [telemetry, setTelemetry] = useState<Record<string, any>>({});
  const [networkHistory, setNetworkHistory] = useState<Record<string, any[]>>({});
  const socketRef = useRef<any>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  
  // Use the modern width provider hook
  const { width, containerRef, mounted } = useContainerWidth();

  // Load widgets from backend
  const loadWidgets = useCallback(async () => {
    try {
      const res = await api.get('/dashboard/widgets');
      setWidgets(res.data.data.widgets);
    } catch (err) {
      console.error('Failed to load widgets', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWidgets();
  }, [loadWidgets]);

  // Socket.io for real-time telemetry
  useEffect(() => {
    const socket = io(window.location.origin, {
      auth: { token: localStorage.getItem('token') },
    });
    socketRef.current = socket;

    socket.on('node:telemetry', ({ nodeId, data }: any) => {
      setTelemetry((prev: any) => ({ ...prev, [nodeId]: data }));
      
      // Update network history for line charts (keep last 20 points)
      if (data.netTxSec !== undefined && data.netRxSec !== undefined) {
        setNetworkHistory((prev: any) => {
          const history = prev[nodeId] || [];
          const newPoint = {
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            tx: data.netTxSec,
            rx: data.netRxSec,
          };
          const newHistory = [...history, newPoint].slice(-20);
          return { ...prev, [nodeId]: newHistory };
        });
      }
    });

    // Subscribe to all nodes used in widgets
    widgets.forEach((w: Widget) => {
      if (w.settings?.nodeId) {
        socket.emit('join:server', w.settings.nodeId);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [widgets]);

  const handleAddWidget = async (newWidget: any) => {
    try {
      const res = await api.post('/dashboard/widgets', newWidget);
      setWidgets((prev: Widget[]) => [...prev, res.data.data.widget]);
      setShowAddModal(false);
    } catch (err) {
      console.error('Failed to add widget', err);
    }
  };

  const handleRemoveWidget = async (id: string) => {
    try {
      await api.delete(`/dashboard/widgets/${id}`);
      setWidgets((prev: Widget[]) => prev.filter((w: Widget) => w.id !== id));
    } catch (err) {
      console.error('Failed to remove widget', err);
    }
  };

  const handleLayoutChange = async (currentLayout: any[]) => {
    if (loading || widgets.length === 0) return;

    const updates = currentLayout.map((l: any) => ({
      id: l.i,
      x: l.x,
      y: l.y,
      w: l.w,
      h: l.h,
    }));

    try {
      await api.patch('/dashboard/widgets/layout', { widgets: updates });
    } catch (err) {
      console.error('Failed to save layout', err);
    }
  };

  const renderWidgetContent = (widget: Widget) => {
    const nodeData = telemetry[widget.settings?.nodeId] || {};
    
    switch (widget.type) {
      case 'SERVER_CARD':
        return (
          <ServerCardWidget 
            nodeId={widget.settings?.nodeId} 
            telemetryData={nodeData} 
            networkHistory={networkHistory[widget.settings?.nodeId] || []} 
          />
        );
      case 'PROJECT_STATUS':
        return <ProjectMiniWidget projectId={widget.settings?.projectId} />;
      default:
        return <div className="text-xs text-text-muted italic">Widget desconhecido</div>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in relative pb-20">
      {/* Dashboard Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <LayoutDashboard className="w-5 h-5 text-accent-light" />
            <h1 className="text-2xl font-bold text-text-primary">Painel Customizado</h1>
          </div>
          <p className="text-text-secondary text-sm">Olá, {user?.name}. Arraste e configure seus widgets como preferir.</p>
        </div>
        
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-accent hover:bg-accent-light text-white font-bold text-sm shadow-lg shadow-accent/20 transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            Adicionar Widget
          </button>
        </div>
      </div>

      {/* Grid Container */}
      <div ref={containerRef as any} className="bg-bg-secondary/20 rounded-2xl border border-dashed border-border min-h-[600px] p-2">
        {widgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center opacity-60">
            <Settings2 className="w-12 h-12 text-text-muted mb-4" />
            <h3 className="text-lg font-bold text-text-primary">Dashboard Vazia</h3>
            <p className="text-sm text-text-muted max-w-xs mt-2">
              Clique em "Adicionar Widget" para começar a monitorar seus servidores e projetos.
            </p>
          </div>
        ) : (
          mounted && (
            <Responsive
              className="layout"
              layouts={{ lg: widgets.map(w => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h })) }}
              breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
              cols={{ lg: 4, md: 3, sm: 2, xs: 1, xxs: 1 }}
              rowHeight={180}
              dragConfig={{ handle: '.drag-handle' }}
              onLayoutChange={(layout) => handleLayoutChange(layout as any[])}
              margin={[16, 16]}
              width={width}
            >
              {widgets.map((widget) => (
                <div key={widget.id}>
                  <BaseWidget
                    title={widget.title}
                    onRemove={() => handleRemoveWidget(widget.id)}
                    dragHandleClass="drag-handle"
                    onClick={() => {
                      if (widget.type === 'SERVER_CARD' && widget.settings?.nodeId) {
                        navigate(`/cloud/servers/${widget.settings.nodeId}`);
                      } else if (widget.type === 'PROJECT_STATUS' && widget.settings?.projectId) {
                        navigate(`/project/${widget.settings.projectId}`);
                      }
                    }}
                  >
                    {renderWidgetContent(widget)}
                  </BaseWidget>
                </div>
              ))}
            </Responsive>
          )
        )}
      </div>

      {showAddModal && (
        <AddWidgetModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddWidget}
        />
      )}
    </div>
  );
}
