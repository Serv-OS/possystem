// src/surfaces/website/Link.jsx
// A link that routes inside the site with pushState and leaves the page for everything else.
// Every href goes through resolveHref (page:<id>, servos:<surface>, plain paths).

import { useSite } from './siteContext.js';
import { resolveHref, isInternalHref } from './resolveHref.js';

export function A({ href, className, children, ...rest }) {
  const { ctx, navigate } = useSite();
  const target = resolveHref(ctx, href);
  if (!target) return null;
  const internal = isInternalHref(target);
  const onClick = (e) => {
    if (!internal || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(target);
  };
  return <a href={target} className={className} onClick={onClick} {...(internal ? {} : { rel: 'noopener' })} {...rest}>{children}</a>;
}
