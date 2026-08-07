#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __linux__
#include <sys/prctl.h>
#endif

#define SKYTURN_WORKTREE_FD 3
#define SKYTURN_OWNER_STATUS_FD 4
#define OWNER_FAILURE_STATUS 70
#define CONTROL_POLL_MS 10

typedef struct {
  int reaped;
  int status;
} RootStatus;

static long long monotonic_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (long long)value.tv_sec * 1000LL + value.tv_nsec / 1000000LL;
}

static void pause_briefly(void) {
  struct timespec delay = {0, CONTROL_POLL_MS * 1000000L};
  while (nanosleep(&delay, &delay) != 0 && errno == EINTR) {
  }
}

static int set_close_on_exec(int descriptor) {
  int flags = fcntl(descriptor, F_GETFD);
  return flags >= 0 && fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0;
}

static int write_all(int descriptor, const char *value, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, value + offset, length - offset);
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return 0;
  }
  return 1;
}

static int write_ready(pid_t root_pid) {
  char message[64];
  int length = snprintf(message, sizeof(message), "R %ld\n", (long)root_pid);
  return length > 0 && (size_t)length < sizeof(message) &&
    write_all(SKYTURN_OWNER_STATUS_FD, message, (size_t)length);
}

static int write_closed(const RootStatus *root) {
  int exit_code = -1;
  int signal_number = 0;
  if (root->reaped && WIFEXITED(root->status)) exit_code = WEXITSTATUS(root->status);
  if (root->reaped && WIFSIGNALED(root->status)) signal_number = WTERMSIG(root->status);
  char message[64];
  int length = snprintf(message, sizeof(message), "C %d %d\n", exit_code, signal_number);
  return length > 0 && (size_t)length < sizeof(message) &&
    write_all(SKYTURN_OWNER_STATUS_FD, message, (size_t)length);
}

static void write_failed(void) {
  (void)write_all(SKYTURN_OWNER_STATUS_FD, "F\n", 2);
}

static int group_alive(pid_t group_id) {
  if (kill(-group_id, 0) == 0) return 1;
  if (errno == EPERM) return 1;
  return errno != ESRCH;
}

static void reap_available(pid_t root_pid, RootStatus *root) {
  for (;;) {
    int status = 0;
    pid_t reaped = waitpid(-1, &status, WNOHANG);
    if (reaped > 0) {
      if (reaped == root_pid && !root->reaped) {
        root->reaped = 1;
        root->status = status;
      }
      continue;
    }
    if (reaped < 0 && errno == EINTR) continue;
    return;
  }
}

static void terminate_and_reap(pid_t root_pid, int cleanup_timeout_ms, RootStatus *root) {
  int term_sent = 0;
  int kill_sent = 0;
  reap_available(root_pid, root);
  if (group_alive(root_pid)) {
    if (kill(-root_pid, SIGTERM) == 0 || errno != ESRCH) term_sent = 1;
  }

  long long deadline = monotonic_ms() + cleanup_timeout_ms;
  for (;;) {
    reap_available(root_pid, root);
    if (root->reaped && !group_alive(root_pid)) return;
    if (monotonic_ms() >= deadline) break;
    pause_briefly();
  }

  if (group_alive(root_pid)) {
    if (kill(-root_pid, SIGKILL) == 0 || errno != ESRCH) kill_sent = 1;
  }
  (void)term_sent;
  (void)kill_sent;
  for (;;) {
    reap_available(root_pid, root);
    if (root->reaped && !group_alive(root_pid)) return;
    pause_briefly();
  }
}

static int parse_cleanup_timeout(const char *value, int *result) {
  char *end = NULL;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 1 || parsed > 30000) return 0;
  *result = (int)parsed;
  return 1;
}

static int prepare_root_group(pid_t root_pid) {
  if (setpgid(root_pid, root_pid) == 0) return 1;
  if ((errno == EACCES || errno == EPERM) && getpgid(root_pid) == root_pid) return 1;
  return 0;
}

static int control_requests_termination(const char *value, ssize_t length) {
  int saw_request = 0;
  for (ssize_t index = 0; index < length; index += 1) {
    if (value[index] == 'T') {
      saw_request = 1;
      continue;
    }
    if (value[index] != '\n') return -1;
  }
  return saw_request;
}

static int await_exec_handoff(int launch_status_fd) {
  for (;;) {
    struct pollfd descriptors[2];
    descriptors[0].fd = launch_status_fd;
    descriptors[0].events = POLLIN | POLLHUP;
    descriptors[0].revents = 0;
    descriptors[1].fd = STDIN_FILENO;
    descriptors[1].events = POLLIN | POLLHUP;
    descriptors[1].revents = 0;
    int ready = poll(descriptors, 2, -1);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) return 0;

    if (descriptors[1].revents != 0) {
      char control[32];
      ssize_t length = read(STDIN_FILENO, control, sizeof(control));
      if (length <= 0) return -1;
      return 0;
    }
    if (descriptors[0].revents != 0) {
      char marker[8];
      ssize_t length = read(launch_status_fd, marker, sizeof(marker));
      if (length == 0) return 1;
      if (length > 0) return 0;
      if (errno == EINTR) continue;
      return 0;
    }
  }
}

static void fail_root_launch(int launch_status_fd) {
  (void)write_all(launch_status_fd, "F", 1);
  _exit(126);
}

static pid_t launch_root(char *const launcher_argv[], int launch_status_pipe[2]) {
  pid_t root_pid = fork();
  if (root_pid != 0) return root_pid;

  (void)signal(SIGPIPE, SIG_DFL);
  if (setpgid(0, 0) != 0) fail_root_launch(launch_status_pipe[1]);
  int null_input = open("/dev/null", O_RDONLY);
  if (null_input < 0 || dup2(null_input, STDIN_FILENO) < 0) {
    fail_root_launch(launch_status_pipe[1]);
  }
  if (null_input != STDIN_FILENO) close(null_input);
  close(launch_status_pipe[0]);
  if (dup2(launch_status_pipe[1], SKYTURN_OWNER_STATUS_FD) < 0) {
    fail_root_launch(launch_status_pipe[1]);
  }
  if (launch_status_pipe[1] != SKYTURN_OWNER_STATUS_FD) close(launch_status_pipe[1]);
  execv(launcher_argv[0], launcher_argv);
  (void)write_all(SKYTURN_OWNER_STATUS_FD, "F", 1);
  _exit(errno == ENOENT ? 127 : 126);
}

int main(int argc, char *argv[]) {
  int cleanup_timeout_ms = 0;
  struct stat worktree;
  if (
    argc < 4 ||
    !parse_cleanup_timeout(argv[1], &cleanup_timeout_ms) ||
    argv[2] == NULL || argv[2][0] != '/' ||
    fstat(SKYTURN_WORKTREE_FD, &worktree) != 0 || !S_ISDIR(worktree.st_mode) ||
    !set_close_on_exec(SKYTURN_OWNER_STATUS_FD)
  ) {
    write_failed();
    return OWNER_FAILURE_STATUS;
  }

#ifdef __linux__
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    write_failed();
    return OWNER_FAILURE_STATUS;
  }
#endif

  int launch_status_pipe[2];
  if (pipe(launch_status_pipe) != 0 || !set_close_on_exec(launch_status_pipe[0])) {
    write_failed();
    return OWNER_FAILURE_STATUS;
  }
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
    write_failed();
    return OWNER_FAILURE_STATUS;
  }

  pid_t root_pid = launch_root(&argv[2], launch_status_pipe);
  if (root_pid < 0) {
    write_failed();
    return OWNER_FAILURE_STATUS;
  }
  close(launch_status_pipe[1]);
  RootStatus root = {0, 0};
  int group_ready = prepare_root_group(root_pid);
  int handoff = group_ready ? await_exec_handoff(launch_status_pipe[0]) : 0;
  close(launch_status_pipe[0]);
  if (handoff != 1 || !write_ready(root_pid)) {
    terminate_and_reap(root_pid, cleanup_timeout_ms, &root);
    if (handoff == 0) write_failed();
    return handoff == -1 ? 0 : OWNER_FAILURE_STATUS;
  }

  int protocol_failed = 0;
  int termination_requested = 0;
  while (!root.reaped && !termination_requested) {
    reap_available(root_pid, &root);
    if (root.reaped) break;
    struct pollfd control = {STDIN_FILENO, POLLIN | POLLHUP, 0};
    int ready = poll(&control, 1, CONTROL_POLL_MS);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) {
      protocol_failed = 1;
      termination_requested = 1;
      break;
    }
    if (ready > 0 && control.revents != 0) {
      char value[64];
      ssize_t length = read(STDIN_FILENO, value, sizeof(value));
      if (length == 0) {
        termination_requested = 1;
        break;
      }
      if (length < 0) {
        if (errno == EINTR) continue;
        protocol_failed = 1;
        termination_requested = 1;
        break;
      }
      int request = control_requests_termination(value, length);
      if (request < 0) protocol_failed = 1;
      if (request != 0) termination_requested = 1;
    }
  }

  reap_available(root_pid, &root);
  if (termination_requested || group_alive(root_pid) || !root.reaped) {
    terminate_and_reap(root_pid, cleanup_timeout_ms, &root);
  }
  if (protocol_failed) {
    write_failed();
    return OWNER_FAILURE_STATUS;
  }
  (void)write_closed(&root);
  return 0;
}
