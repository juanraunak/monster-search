import Fastify from "fastify";
import courseRoute from "./routes/course";

const app = Fastify({ logger: true });

app.register(courseRoute);

app.listen({ port: 3000 }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running at ${address}`);
});
