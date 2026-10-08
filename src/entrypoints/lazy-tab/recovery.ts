export interface LazyRecoveryOptions {
  unavailable: boolean;
  originalUrl?: string;
  onRetry: () => void;
  onClose: () => void;
  navigate?: (url: string) => void;
}

function navigableUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function renderLazyRecovery(container: HTMLElement, options: LazyRecoveryOptions) {
  const brand = document.createElement('strong');
  brand.textContent = 'WindowStash';
  const message = document.createElement('p');
  message.textContent = '无法恢复此标签页';
  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = options.unavailable ? '关闭此标签页' : '重新加载原页面';
  action.onclick = options.unavailable ? options.onClose : options.onRetry;
  const children: Node[] = [brand];
  const originalUrl = navigableUrl(options.originalUrl);
  if (originalUrl) {
    const originalSite = document.createElement('div');
    originalSite.className = 'original-site';
    const link = document.createElement('a');
    link.href = originalUrl;
    link.textContent = originalUrl;
    link.onclick = (event) => {
      event.preventDefault();
      (options.navigate ?? ((url) => location.assign(url)))(originalUrl);
    };
    originalSite.append(link);
    children.push(originalSite);
  }
  children.push(message, action);
  container.replaceChildren(...children);
}
