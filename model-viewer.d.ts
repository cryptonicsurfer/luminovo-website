// <model-viewer> som JSX-element. React 19 läser JSX-namespacet från 'react',
// inte globalt — därför augmenteras modulen här.
import 'react';

type ModelViewerAttrs = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string;
  'ios-src'?: string;
  alt?: string;
  'auto-rotate'?: boolean;
  'camera-controls'?: boolean;
  'shadow-intensity'?: string;
  'environment-image'?: string;
  exposure?: string;
  ar?: boolean;
  'ar-modes'?: string;
  'ar-scale'?: string;
  loading?: 'auto' | 'lazy' | 'eager';
};

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerAttrs;
    }
  }
}
