import { Spiceflow } from "spiceflow";

const app = new Spiceflow().get("/ping", () => {
  return { pong: true };
});

export default {
  fetch(request: Request) {
    return app.handle(request);
  },
};

export { app };
