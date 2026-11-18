// nahflix.pages.dev serves the static site; every /api/* call goes to the nahflix Worker.
export const onRequest = ({ request, env }) => env.API.fetch(request);
