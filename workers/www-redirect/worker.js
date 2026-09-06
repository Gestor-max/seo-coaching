/** 301-redirects www.seo-coaching.net/* to seo-coaching.net/* (query preserved) */
export default {
  fetch(request) {
    const url = new URL(request.url);
    const target = `https://seo-coaching.net${url.pathname}${url.search}`;
    return Response.redirect(target, 301);
  },
};
