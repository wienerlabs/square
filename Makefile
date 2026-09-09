# The one command is `make up`.
#
# It brings up a local chain, puts the contracts on it, builds the circuit
# artifacts, migrates the database, and starts the prover, the indexer, the
# keeper and the application. It returns only once every one of them reports
# healthy, so a zero exit status is the evidence that the stack is up.
#
# Nothing but Docker has to be installed. circom, snarkjs and forge all run in
# containers; see circuits/Dockerfile and compose.yaml.

COMPOSE ?= docker compose
SERVICES := prover indexer keeper app

.PHONY: up down stop logs ps health clean rebuild

# The long-running services are named explicitly so that --wait has only
# health checks to wait on: the deployer, the migration and the circuit build
# are one shots that the four below already depend on, and compose starts them
# first and waits for a clean exit before it starts anything that needs them.
up: .env
	$(COMPOSE) up --build --detach --wait $(SERVICES)
	@$(MAKE) --no-print-directory health

down:
	$(COMPOSE) down --remove-orphans

# Everything, including the chain state, the database and the circuit artifacts.
clean:
	$(COMPOSE) down --volumes --remove-orphans

stop:
	$(COMPOSE) stop

rebuild:
	$(COMPOSE) build --no-cache

logs:
	$(COMPOSE) logs --follow

ps:
	$(COMPOSE) ps

# What each service says about itself, over the published port.
health:
	@./scripts/health.sh

.env:
	@cp .env.example .env
	@echo "wrote .env from .env.example"
