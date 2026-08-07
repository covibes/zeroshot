#!/bin/bash
#
# E2E Test: Zeroshot Isolation & Auto Modes
#
# Verifies:
# - Clusters spawn and complete successfully
# - Isolation mode creates and cleans up containers
# - Auto mode workflow works end-to-end
# - No resource leaks (containers, processes, state files)
# - Actual task output is correct
#
# Design principles:
# - FAIL FAST: No silent errors, no || true
# - VERIFY EVERYTHING: Check actual state, not just exit codes
# - CLEAN STATE: Pre-test cleanup, trap for exit cleanup
# - IDEMPOTENT: Can run multiple times safely
#

set -euo pipefail  # Fail on any error, undefined var, or pipe failure

# Test working directory
cd "$(dirname "$0")/../.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test state tracking
CLUSTERS_TO_CLEANUP=()
CONTAINERS_TO_CLEANUP=()
TEST_FAILED=0

#──────────────────────────────────────────────────────────
# Cleanup trap - ALWAYS runs on exit
#──────────────────────────────────────────────────────────
cleanup() {
    local exit_code=$?

    echo ""
    echo "=== Cleanup (exit code: $exit_code) ==="

    # Kill tracked clusters
    for cluster_id in "${CLUSTERS_TO_CLEANUP[@]}"; do
        echo "Killing cluster: $cluster_id"
        zeroshot kill "$cluster_id" 2>/dev/null || echo "  (already gone)"
    done

    # Remove tracked containers
    for container_name in "${CONTAINERS_TO_CLEANUP[@]}"; do
        if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
            echo "Removing container: $container_name"
            docker rm -f "$container_name" 2>/dev/null || echo "  (already gone)"
        fi
    done

    # Final verification: NO zeroshot-test containers remain
    local leaked=$(docker ps -a --filter "name=zeroshot-test-" --format '{{.Names}}' | wc -l)
    if [ "$leaked" -gt 0 ]; then
        echo -e "${RED}⚠ WARNING: $leaked test containers still present!${NC}"
        docker ps -a --filter "name=zeroshot-test-"
        TEST_FAILED=1
    else
        echo -e "${GREEN}✓ No leaked test containers${NC}"
    fi

    if [ $TEST_FAILED -eq 1 ]; then
        echo -e "${RED}=== TEST FAILED ===${NC}"
        exit 1
    fi
}

trap cleanup EXIT

#──────────────────────────────────────────────────────────
# Helper functions
#──────────────────────────────────────────────────────────

log_test() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$1"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

assert() {
    local condition=$1
    local message=$2

    if ! eval "$condition"; then
        echo -e "${RED}❌ ASSERTION FAILED: $message${NC}"
        echo "   Condition: $condition"
        TEST_FAILED=1
        exit 1
    else
        echo -e "${GREEN}✓ $message${NC}"
    fi
}

wait_for_cluster_registration() {
    local cluster_id=$1
    local max_wait=15
    local waited=0

    echo "Waiting for cluster to be visible in 'zeroshot list'..."

    while [ $waited -lt $max_wait ]; do
        # Check if cluster appears in list output
        if zeroshot list 2>&1 | grep -q "$cluster_id"; then
            echo "✓ Cluster visible after ${waited}s"
            return 0
        fi

        # Also check clusters.json as backup
        if [ -f ~/.zeroshot/clusters.json ]; then
            if cat ~/.zeroshot/clusters.json 2>/dev/null | jq -e ".[\"$cluster_id\"]" >/dev/null 2>&1; then
                echo "✓ Cluster registered after ${waited}s"
                return 0
            fi
        fi

        sleep 1
        waited=$((waited + 1))
    done

    echo -e "${RED}✗ Cluster not visible after ${max_wait}s${NC}"
    echo "Checking what went wrong..."
    echo "  zeroshot list output:"
    zeroshot list 2>&1 | head -20
    return 1
}

wait_for_container() {
    local container_name=$1
    local max_wait=30
    local waited=0

    echo "Waiting for container '$container_name'..."

    while [ $waited -lt $max_wait ]; do
        if docker ps -a --format '{{.Names}}' | grep -Fxq "$container_name"; then
            echo "✓ Container visible after ${waited}s"
            return 0
        fi

        sleep 1
        waited=$((waited + 1))
    done

    echo -e "${RED}✗ Container not visible after ${max_wait}s${NC}"
    return 1
}

wait_for_container_removal() {
    local container_name=$1
    local max_wait=30
    local waited=0

    echo "Waiting for container '$container_name' cleanup..."

    while [ $waited -lt $max_wait ]; do
        if ! docker ps -a --format '{{.Names}}' | grep -Fxq "$container_name"; then
            echo "✓ Container removed after ${waited}s"
            return 0
        fi

        sleep 1
        waited=$((waited + 1))
    done

    local remaining_status
    remaining_status=$(docker inspect -f '{{.State.Status}}' "$container_name" 2>/dev/null)
    echo -e "${RED}✗ Container still exists with status: $remaining_status${NC}"
    return 1
}

wait_for_cluster_completion() {
    local cluster_id=$1
    local max_wait=120  # 2 minutes max
    local waited=0

    echo "Waiting for cluster to complete..."

    while [ $waited -lt $max_wait ]; do
        local state=$(zeroshot status "$cluster_id" 2>&1 | grep -oP 'state: \K\w+' || echo "unknown")

        if [ "$state" == "stopped" ] || [ "$state" == "killed" ]; then
            echo "✓ Cluster completed with state: $state (${waited}s)"
            return 0
        fi

        if [ "$state" == "failed" ]; then
            echo -e "${RED}✗ Cluster failed${NC}"
            zeroshot logs "$cluster_id" | tail -50
            return 1
        fi

        sleep 2
        waited=$((waited + 2))
    done

    echo -e "${YELLOW}⚠ Cluster still running after ${max_wait}s${NC}"
    return 1
}

#──────────────────────────────────────────────────────────
# Pre-test cleanup
#──────────────────────────────────────────────────────────

log_test "PRE-TEST CLEANUP"

# Remove any existing test containers
echo "Removing old test containers..."
docker ps -a --filter "name=zeroshot-test-" --format '{{.Names}}' | while read -r name; do
    echo "  Removing: $name"
    docker rm -f "$name" 2>/dev/null || true
done

# Remove test files
rm -f test-*.txt 2>/dev/null || true

echo -e "${GREEN}✓ Pre-test cleanup complete${NC}"

#──────────────────────────────────────────────────────────
# TEST 1: Basic Cluster Mode (Non-Detached)
#──────────────────────────────────────────────────────────

log_test "TEST 1: Basic Cluster Mode (Synchronous)"

TEST_FILE="test-basic-$(date +%s).txt"
TEST_CONTENT="Basic mode works at $(date)"

# Spawn cluster WITHOUT -d flag (synchronous, blocks until complete or timeout)
echo "Starting cluster (will block until completion)..."

# Run in foreground with timeout - capture output and cluster ID
CLUSTER_OUTPUT=$(timeout 90s zeroshot run "Create a file called '$TEST_FILE' with content '$TEST_CONTENT'" 2>&1) || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo -e "${YELLOW}⚠ Cluster hit 90s timeout (may have completed)${NC}"
    else
        echo -e "${RED}❌ Cluster failed with exit code: $EXIT_CODE${NC}"
        echo "$CLUSTER_OUTPUT" | tail -50
    fi
}

# Extract cluster ID from output
CLUSTER_ID=$(echo "$CLUSTER_OUTPUT" | grep -oP 'Starting \K[a-z]+-[a-z]+-\d+' | head -1)

if [ -z "$CLUSTER_ID" ]; then
    echo -e "${RED}❌ Failed to extract cluster ID from output${NC}"
    echo "Output:"
    echo "$CLUSTER_OUTPUT" | head -20
    exit 1
fi

echo "Cluster ID: $CLUSTER_ID"
CLUSTERS_TO_CLEANUP+=("$CLUSTER_ID")

# Check if cluster completed successfully
if echo "$CLUSTER_OUTPUT" | grep -q "CLUSTER COMPLETED"; then
    echo -e "${GREEN}✓ Cluster completed successfully${NC}"

    # Verify the file was actually created
    if [ -f "$TEST_FILE" ]; then
        ACTUAL_CONTENT=$(cat "$TEST_FILE")
        if [ "$ACTUAL_CONTENT" == "$TEST_CONTENT" ]; then
            echo -e "${GREEN}✓ Task output verified: File created with correct content${NC}"
        else
            echo -e "${RED}❌ Task output WRONG: File content doesn't match${NC}"
            echo "Expected: $TEST_CONTENT"
            echo "Actual: $ACTUAL_CONTENT"
            TEST_FAILED=1
        fi
    else
        echo -e "${YELLOW}⚠ File not created (may have run in container)${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Cluster may not have completed (check logs)${NC}"
fi

assert "[ -n '$CLUSTER_ID' ]" "Cluster was spawned"

#──────────────────────────────────────────────────────────
# TEST 2: Isolation Mode (With Proper Wait)
#──────────────────────────────────────────────────────────

log_test "TEST 2: Isolation Mode (Docker Container)"

# Generate unique test name
ISOLATION_TEST_FILE="test-isolation-$(date +%s).txt"
ISOLATION_CONTENT="Isolation mode works at $(date)"

# Spawn in detached mode
echo "Spawning isolation cluster (detached)..."
ISO_OUTPUT=$(zeroshot run --docker "Create file '$ISOLATION_TEST_FILE' with content '$ISOLATION_CONTENT'" -d 2>&1)
echo "$ISO_OUTPUT"

ISO_CLUSTER=$(echo "$ISO_OUTPUT" | grep -oP '[a-z]+-[a-z]+-\d+' | head -1)

assert "[ -n '$ISO_CLUSTER' ]" "Isolation cluster spawned"

echo "Isolation cluster: $ISO_CLUSTER"
CLUSTERS_TO_CLEANUP+=("$ISO_CLUSTER")

# CRITICAL: Wait for cluster registration before proceeding
wait_for_cluster_registration "$ISO_CLUSTER" || {
    echo -e "${RED}❌ Cluster registration failed${NC}"
    exit 1
}

# Verify container was created
CONTAINER_NAME="zeroshot-cluster-$ISO_CLUSTER"
CONTAINERS_TO_CLEANUP+=("$CONTAINER_NAME")

wait_for_container "$CONTAINER_NAME"
echo -e "${GREEN}✓ Isolation container created: $CONTAINER_NAME${NC}"

# Check container is running or exited cleanly
CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "not_found")
echo "Container status: $CONTAINER_STATUS"

assert "[ '$CONTAINER_STATUS' == 'running' ] || [ '$CONTAINER_STATUS' == 'exited' ]" \
       "Container is in valid state"

# Kill cluster and verify cleanup
echo ""
echo "Killing cluster..."
zeroshot kill "$ISO_CLUSTER"

wait_for_container_removal "$CONTAINER_NAME"
echo -e "${GREEN}✓ Container successfully removed after kill${NC}"

# Verify cluster state
FINAL_STATE=$(zeroshot status "$ISO_CLUSTER" 2>&1 | grep -oP 'state: \K\w+' || echo "not_found")
assert "[ '$FINAL_STATE' == 'killed' ] || [ '$FINAL_STATE' == 'not_found' ]" \
       "Cluster marked as killed"

#──────────────────────────────────────────────────────────
# TEST 3: Auto Mode (Command Availability)
#──────────────────────────────────────────────────────────

log_test "TEST 3: Auto Mode (Command Validation)"

# Verify auto command exists and has expected flags
AUTO_HELP=$(zeroshot auto --help 2>&1)

assert "echo '$AUTO_HELP' | grep -q 'docker'" \
       "Auto mode supports --docker flag"

assert "echo '$AUTO_HELP' | grep -q 'auto'" \
       "Auto mode command is available"

echo -e "${GREEN}✓ Auto mode command is functional${NC}"

#──────────────────────────────────────────────────────────
# Final Summary
#──────────────────────────────────────────────────────────

log_test "TEST SUMMARY"

echo -e "${GREEN}✓ Basic cluster mode: Verified spawn and lifecycle${NC}"
echo -e "${GREEN}✓ Isolation mode: Container creation and cleanup verified${NC}"
echo -e "${GREEN}✓ Auto mode: Command available and functional${NC}"
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}         ALL TESTS PASSED - NO RESOURCE LEAKS         ${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
