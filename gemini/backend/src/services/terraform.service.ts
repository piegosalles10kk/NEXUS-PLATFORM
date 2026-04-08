import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TerraformProviderConfig {
  type: 'AWS' | 'DIGITALOCEAN' | 'AZURE' | 'GCP';
  apiKey: string;           // DO token | AWS secret key | Azure client secret | GCP service-account JSON
  apiKeyId?: string;        // AWS access key ID | Azure client ID
  region: string;
  // Azure only
  tenantId?: string;
  subscriptionId?: string;
  // GCP only
  gcpProjectId?: string;
}

export interface TerraformServerConfig {
  name: string;
  instanceType: string;     // e.g. "s-1vcpu-1gb" (DO) or "t3.micro" (AWS)
  sshPublicKey: string;
  enrollmentToken: string;  // Pre-generated token so cloud-init can auto-enroll the agent
}

/** Cloud-init script: installs Docker + 10KK Agent on the provisioned VPS */
function buildCloudInit(platformUrl: string, enrollmentToken: string): string {
  // Normalize: ensure no trailing slash and derive WSS URL
  const base = platformUrl.replace(/\/$/, '');
  const wssUrl = base.replace(/^http/, 'ws') + '/ws/agent';

  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ── Install Docker ──────────────────────────────────────────────────────────────
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker

# ── Install Nexus Agent ──────────────────────────────────────────────────────
mkdir -p /opt/nexus-agent

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH_SUFFIX="amd64" ;;
  aarch64) ARCH_SUFFIX="arm64" ;;
  *)       ARCH_SUFFIX="amd64" ;;
esac

# Download install script + binary from the platform
curl -fsSL "${base}/install.sh" -o /tmp/nexus-install.sh
chmod +x /tmp/nexus-install.sh

# Run installer — it places the binary, creates systemd unit and starts the service
/tmp/nexus-install.sh \\
  --token  "${enrollmentToken}" \\
  --master "${wssUrl}" \\
  --arch   "$ARCH_SUFFIX"

echo "[Nexus] Agent installation complete."
`;
}

/** Generates a Terraform configuration for a DigitalOcean droplet */
function buildDigitalOceanConfig(
  provider: TerraformProviderConfig,
  server: TerraformServerConfig,
  platformUrl: string,
): string {
  const cloudInit = buildCloudInit(platformUrl, server.enrollmentToken);
  const b64Init = Buffer.from(cloudInit).toString('base64');

  return `terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = "${provider.apiKey}"
}

resource "digitalocean_ssh_key" "10kk_key" {
  name       = "10kk-${server.name}"
  public_key = "${server.sshPublicKey}"
}

resource "digitalocean_droplet" "server" {
  name     = "${server.name}"
  region   = "${provider.region}"
  size     = "${server.instanceType}"
  image    = "ubuntu-22-04-x64"
  ssh_keys = [digitalocean_ssh_key.10kk_key.id]
  user_data = base64decode("${b64Init}")
}

output "ipv4_address" {
  value = digitalocean_droplet.server.ipv4_address
}
`;
}

/** Generates a Terraform configuration for an Azure Linux VM */
function buildAzureConfig(
  provider: TerraformProviderConfig,
  server: TerraformServerConfig,
  platformUrl: string,
): string {
  const cloudInit = buildCloudInit(platformUrl, server.enrollmentToken);

  return `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features         {}
  subscription_id  = "${provider.subscriptionId}"
  client_id        = "${provider.apiKeyId}"
  client_secret    = "${provider.apiKey}"
  tenant_id        = "${provider.tenantId}"
}

resource "azurerm_resource_group" "rg" {
  name     = "10kk-${server.name}-rg"
  location = "${provider.region}"
}

resource "azurerm_virtual_network" "vnet" {
  name                = "10kk-${server.name}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet" "subnet" {
  name                 = "internal"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_public_ip" "pip" {
  name                = "10kk-${server.name}-pip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
}

resource "azurerm_network_interface" "nic" {
  name                = "10kk-${server.name}-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.pip.id
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                  = "${server.name}"
  resource_group_name   = azurerm_resource_group.rg.name
  location              = azurerm_resource_group.rg.location
  size                  = "${server.instanceType}"
  admin_username        = "adminuser"
  network_interface_ids = [azurerm_network_interface.nic.id]

  admin_ssh_key {
    username   = "adminuser"
    public_key = "${server.sshPublicKey}"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts"
    version   = "latest"
  }

  custom_data = base64encode(<<-EOT
${cloudInit}
  EOT)

  tags = {
    ManagedBy = "10KK-Platform"
  }
}

output "public_ip" {
  value = azurerm_public_ip.pip.ip_address
}
`;
}

/** Generates a Terraform configuration for a GCP Compute Engine VM */
function buildGCPConfig(
  provider: TerraformProviderConfig,
  server: TerraformServerConfig,
  platformUrl: string,
): string {
  const cloudInit = buildCloudInit(platformUrl, server.enrollmentToken);

  return `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  credentials = <<EOF
${provider.apiKey}
EOF
  project = "${provider.gcpProjectId}"
  region  = "${provider.region}"
  zone    = "${provider.region}-a"
}

resource "google_compute_instance" "vm" {
  name         = "${server.name}"
  machine_type = "${server.instanceType}"
  zone         = "${provider.region}-a"

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 20
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  metadata = {
    ssh-keys = "ubuntu:${server.sshPublicKey}"
  }

  metadata_startup_script = <<-EOT
${cloudInit}
EOT

  tags = ["nexus-managed"]

  labels = {
    managed-by = "nexus-platform"
  }
}

output "public_ip" {
  value = google_compute_instance.vm.network_interface[0].access_config[0].nat_ip
}
`;
}

/** Generates a Terraform configuration for an AWS EC2 instance */
function buildAWSConfig(
  provider: TerraformProviderConfig,
  server: TerraformServerConfig,
  platformUrl: string,
): string {
  const cloudInit = buildCloudInit(platformUrl, server.enrollmentToken);

  return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  access_key = "${provider.apiKeyId}"
  secret_key = "${provider.apiKey}"
  region     = "${provider.region}"
}

resource "aws_key_pair" "10kk_key" {
  key_name   = "10kk-${server.name}"
  public_key = "${server.sshPublicKey}"
}

resource "aws_instance" "server" {
  ami           = "ami-0c02fb55956c7d316"  # Amazon Linux 2 us-east-1
  instance_type = "${server.instanceType}"
  key_name      = aws_key_pair.10kk_key.key_name

  user_data = <<-EOF
${cloudInit}
  EOF

  tags = {
    Name = "${server.name}"
    ManagedBy = "10KK-Platform"
  }
}

output "public_ip" {
  value = aws_instance.server.public_ip
}
`;
}

function runTerraformCommand(
  args: string[],
  workDir: string,
  onLog: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('terraform', args, { cwd: workDir, shell: false });
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      stdout += line;
      onLog(line.trimEnd());
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      onLog(chunk.toString().trimEnd());
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`terraform ${args[0]} exited with code ${code}`));
    });
    proc.on('error', (err) => {
      reject(new Error(`Could not start Terraform: ${err.message}. Ensure terraform CLI is installed.`));
    });
  });
}

export async function provisionServer(
  provider: TerraformProviderConfig,
  server: TerraformServerConfig,
  platformUrl: string,
  onLog: (line: string) => void,
): Promise<{ ip: string; workDir: string }> {
  const workDir = path.join(os.tmpdir(), `10kk-tf-${server.name}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const tfConfig =
    provider.type === 'DIGITALOCEAN'
      ? buildDigitalOceanConfig(provider, server, platformUrl)
      : provider.type === 'AZURE'
        ? buildAzureConfig(provider, server, platformUrl)
        : provider.type === 'GCP'
          ? buildGCPConfig(provider, server, platformUrl)
          : buildAWSConfig(provider, server, platformUrl);

  fs.writeFileSync(path.join(workDir, 'main.tf'), tfConfig);
  onLog(`📁 Terraform config written to ${workDir}`);

  onLog('🔧 Running terraform init...');
  await runTerraformCommand(['init', '-no-color'], workDir, onLog);

  onLog('🚀 Running terraform apply...');
  await runTerraformCommand(['apply', '-auto-approve', '-no-color'], workDir, onLog);

  onLog('📤 Reading output...');
  const outputJson = await runTerraformCommand(['output', '-json', '-no-color'], workDir, onLog);
  const outputs = JSON.parse(outputJson);
  const ip =
    outputs.ipv4_address?.value ??
    outputs.public_ip?.value ??
    '';

  onLog(`✅ Server provisioned at ${ip}`);
  return { ip, workDir };
}

export async function destroyServer(
  workDir: string,
  onLog: (line: string) => void,
): Promise<void> {
  if (!fs.existsSync(workDir)) {
    onLog('⚠️  Terraform work directory not found, skipping destroy.');
    return;
  }
  onLog('💥 Running terraform destroy...');
  await runTerraformCommand(['destroy', '-auto-approve', '-no-color'], workDir, onLog);
  fs.rmSync(workDir, { recursive: true, force: true });
  onLog('✅ Server destroyed and workspace cleaned.');
}
