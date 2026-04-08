import api from './api';

export interface GatewayRoute {
  id: string;
  name: string;
  routePath: string;
  targetUrl: string;
  checkPort: number;
  isActive: boolean;
  isTunnelled: boolean;
  tunnelNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayStats {
  totalGateways: number;
  activeGateways: number;
  usedPorts: number;
  availablePorts: number;
}

export const GatewayService = {
  async getRoutes(): Promise<GatewayRoute[]> {
    const response = await api.get('/gateway');
    return response.data;
  },

  async createRoute(data: Partial<GatewayRoute>): Promise<GatewayRoute> {
    const response = await api.post('/gateway', data);
    return response.data;
  },

  async updateRoute(id: string, data: Partial<GatewayRoute>): Promise<GatewayRoute> {
    const response = await api.put(`/gateway/${id}`, data);
    return response.data;
  },

  async deleteRoute(id: string): Promise<void> {
    await api.delete(`/gateway/${id}`);
  },

  async discoverPorts(): Promise<{ host: string; activePorts: number[] }> {
    const response = await api.get('/gateway/discover');
    return response.data;
  },

  async getStats(): Promise<GatewayStats> {
    const response = await api.get('/gateway/stats');
    return response.data;
  }
};
