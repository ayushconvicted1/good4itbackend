const request = require("supertest");
const app = require("../server");

describe("API Health Check", () => {
  test("GET /api/health should return 200", async () => {
    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toHaveProperty("status", "OK");
    expect(response.body).toHaveProperty("message");
    expect(response.body).toHaveProperty("timestamp");
  });
});

describe("Authentication Routes", () => {
  test("POST /api/auth/signup should validate required fields", async () => {
    const response = await request(app)
      .post("/api/auth/signup")
      .send({})
      .expect(400);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("message", "Validation error");
    expect(response.body).toHaveProperty("errors");
  });

  test("POST /api/auth/login should validate required fields", async () => {
    const response = await request(app)
      .post("/api/auth/login")
      .send({})
      .expect(400);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("message", "Validation error");
  });
});

describe("Protected Routes", () => {
  test("GET /api/user/profile should require authentication", async () => {
    const response = await request(app).get("/api/user/profile").expect(401);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("message", "Access token required");
  });
});
