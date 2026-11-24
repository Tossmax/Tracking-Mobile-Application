import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Alert,
  type AppStateStatus,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

const STORAGE_KEY = "app-usage-tracker";
const MAX_ACTIVITY_ITEMS = 250;

type TaskItem = {
  id: string;
  title: string;
  createdAt: number;
  completedAt: number | null;
};

type ActivityItem = {
  id: string;
  label: string;
  timestamp: number;
};

type UsageStats = {
  trackingEnabled: boolean;
  launchCount: number;
  totalSeconds: number;
  activities: ActivityItem[];
  tasks: TaskItem[];
};

type DashboardTab = "overview" | "tasks" | "activity";

const EMPTY_STATS: UsageStats = {
  trackingEnabled: false,
  launchCount: 0,
  totalSeconds: 0,
  activities: [],
  tasks: [],
};

function isTaskItem(value: unknown): value is TaskItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.createdAt === "number" &&
    (task.completedAt === null || typeof task.completedAt === "number")
  );
}

function isUsageStats(value: unknown): value is UsageStats {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const stats = value as Record<string, unknown>;
  return (
    typeof stats.trackingEnabled === "boolean" &&
    typeof stats.launchCount === "number" &&
    typeof stats.totalSeconds === "number" &&
    Array.isArray(stats.activities) &&
    (stats.tasks === undefined ||
      (Array.isArray(stats.tasks) && stats.tasks.every(isTaskItem))) &&
    stats.activities.every(
      (activity) =>
        typeof activity === "object" &&
        activity !== null &&
        typeof activity.id === "string" &&
        typeof activity.label === "string" &&
        typeof activity.timestamp === "number",
    )
  );
}

function addActivity(stats: UsageStats, label: string): UsageStats {
  const activity: ActivityItem = {
    id: `${Date.now()}-${Math.random()}`,
    label,
    timestamp: Date.now(),
  };

  return {
    ...stats,
    activities: [activity, ...stats.activities].slice(0, MAX_ACTIVITY_ITEMS),
  };
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getAppState(state: string | null | undefined): AppStateStatus {
  switch (state) {
    case "active":
    case "background":
    case "inactive":
    case "extension":
    case "unknown":
      return state;
    default:
      return "unknown";
  }
}

function AppContent() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [visitSeconds, setVisitSeconds] = useState(0);
  const [taskInput, setTaskInput] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskEditDraft, setTaskEditDraft] = useState("");

  const statsRef = useRef<UsageStats | null>(null);
  const activeSinceRef = useRef<number | null>(null);
  const visitSecondsRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(getAppState(AppState.currentState));
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  const saveStats = useCallback((nextStats: UsageStats) => {
    const serialized = JSON.stringify(nextStats);
    writeQueueRef.current = writeQueueRef.current
      .then(() => AsyncStorage.setItem(STORAGE_KEY, serialized))
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Unknown storage error";
        setStorageError(`Your latest changes could not be saved: ${message}`);
      });
  }, []);

  const commitStats = useCallback(
    (nextStats: UsageStats) => {
      statsRef.current = nextStats;
      setStats(nextStats);
      saveStats(nextStats);
    },
    [saveStats],
  );

  const recordActivity = useCallback(
    (label: string) => {
      const currentStats = statsRef.current;
      if (!currentStats?.trackingEnabled) {
        return;
      }

      commitStats(addActivity(currentStats, label));
    },
    [commitStats],
  );

  const commitElapsedTime = useCallback(() => {
    const activeSince = activeSinceRef.current;
    const currentStats = statsRef.current;
    if (activeSince === null || !currentStats?.trackingEnabled) {
      return;
    }

    const now = Date.now();
    const elapsed = Math.floor((now - activeSince) / 1000);
    if (elapsed < 1) {
      return;
    }

    activeSinceRef.current = now;
    visitSecondsRef.current += elapsed;
    setVisitSeconds(visitSecondsRef.current);
    setSessionSeconds(0);
    commitStats({
      ...currentStats,
      totalSeconds: currentStats.totalSeconds + elapsed,
    });
  }, [commitStats]);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const storedStats = await AsyncStorage.getItem(STORAGE_KEY);
      if (storedStats === null) {
        statsRef.current = EMPTY_STATS;
        setStats(EMPTY_STATS);
        return;
      }

      const parsedStats: unknown = JSON.parse(storedStats);
      if (!isUsageStats(parsedStats)) {
        throw new Error("Saved usage data has an unexpected format.");
      }

      let nextStats: UsageStats = {
        ...parsedStats,
        tasks: parsedStats.tasks ?? [],
      };
      if (nextStats.trackingEnabled) {
        visitSecondsRef.current = 0;
        setVisitSeconds(0);
        nextStats = addActivity(
          {
            ...nextStats,
            launchCount: nextStats.launchCount + 1,
          },
          "App opened",
        );
        activeSinceRef.current = Date.now();
      }

      commitStats(nextStats);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown storage error";
      setLoadError(`Your usage data could not be loaded: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [commitStats]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === "active" && previousState !== "active") {
        if (statsRef.current?.trackingEnabled) {
          activeSinceRef.current = Date.now();
          recordActivity("Returned to the app");
        }
      } else if (previousState === "active" && nextState !== "active") {
        commitElapsedTime();
        activeSinceRef.current = null;
      }
    });

    return () => subscription.remove();
  }, [commitElapsedTime, recordActivity]);

  useEffect(() => {
    if (!stats?.trackingEnabled || activeSinceRef.current === null) {
      return;
    }

    const timer = setInterval(() => {
      const activeSince = activeSinceRef.current;
      if (activeSince === null) {
        return;
      }

      const elapsedMilliseconds = Date.now() - activeSince;
      const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);
      setSessionSeconds(elapsedSeconds);
      setVisitSeconds(visitSecondsRef.current + elapsedSeconds);
      if (elapsedMilliseconds >= 30_000) {
        commitElapsedTime();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [commitElapsedTime, stats?.trackingEnabled]);

  const startTracking = () => {
    const nextStats = addActivity(
      {
        ...EMPTY_STATS,
        trackingEnabled: true,
        launchCount: 1,
      },
      "Tracking started",
    );

    activeSinceRef.current = Date.now();
    visitSecondsRef.current = 0;
    setVisitSeconds(0);
    setSessionSeconds(0);
    setTab("overview");
    commitStats(nextStats);
  };

  const changeTab = (nextTab: DashboardTab) => {
    if (tab === nextTab) {
      return;
    }

    setTab(nextTab);
    recordActivity(
      nextTab === "overview"
        ? "Viewed your overview"
        : nextTab === "tasks"
          ? "Opened your task list"
          : "Opened activity history",
    );
  };

  const addTask = () => {
    const title = taskInput.trim();
    if (!title) {
      return;
    }

    const currentStats = statsRef.current;
    if (!currentStats) {
      return;
    }

    const task: TaskItem = {
      id: `${Date.now()}-${Math.random()}`,
      title,
      createdAt: Date.now(),
      completedAt: null,
    };
    const nextStats = addActivity(
      { ...currentStats, tasks: [task, ...currentStats.tasks] },
      `Added task: ${title}`,
    );

    setTaskInput("");
    commitStats(nextStats);
  };

  const toggleTask = (taskId: string) => {
    const currentStats = statsRef.current;
    const task = currentStats?.tasks.find((item) => item.id === taskId);
    if (!currentStats || !task) {
      return;
    }

    const completing = task.completedAt === null;
    const updatedTask: TaskItem = {
      ...task,
      completedAt: completing ? Date.now() : null,
    };
    const nextStats = addActivity(
      {
        ...currentStats,
        tasks: currentStats.tasks.map((item) =>
          item.id === taskId ? updatedTask : item,
        ),
      },
      `${completing ? "Completed" : "Reopened"} task: ${task.title}`,
    );
    commitStats(nextStats);
  };

  const moveTask = (taskId: string, direction: "up" | "down") => {
    const currentStats = statsRef.current;
    const taskIndex = currentStats?.tasks.findIndex((item) => item.id === taskId);
    if (!currentStats || taskIndex === undefined || taskIndex < 0) {
      return;
    }

    const task = currentStats.tasks[taskIndex];
    const sameSectionIndexes = currentStats.tasks.reduce<number[]>(
      (indexes, item, index) => {
        if ((item.completedAt === null) === (task.completedAt === null)) {
          indexes.push(index);
        }
        return indexes;
      },
      [],
    );
    const sectionPosition = sameSectionIndexes.indexOf(taskIndex);
    const targetPosition = sectionPosition + (direction === "up" ? -1 : 1);
    const targetIndex = sameSectionIndexes[targetPosition];
    if (targetIndex === undefined) {
      return;
    }

    const tasks = [...currentStats.tasks];
    [tasks[taskIndex], tasks[targetIndex]] = [tasks[targetIndex], tasks[taskIndex]];
    commitStats(
      addActivity(
        { ...currentStats, tasks },
        `Moved task ${direction}: ${task.title}`,
      ),
    );
  };

  const beginTaskEdit = (taskId: string) => {
    const task = statsRef.current?.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    setEditingTaskId(taskId);
    setTaskEditDraft(task.title);
  };

  const cancelTaskEdit = () => {
    setEditingTaskId(null);
    setTaskEditDraft("");
  };

  const saveTaskEdit = () => {
    const currentStats = statsRef.current;
    const task = currentStats?.tasks.find((item) => item.id === editingTaskId);
    const title = taskEditDraft.trim();
    if (!currentStats || !task || !title) {
      return;
    }

    if (task.title !== title) {
      const tasks = currentStats.tasks.map((item) =>
        item.id === task.id ? { ...item, title } : item,
      );
      commitStats(
        addActivity(
          { ...currentStats, tasks },
          `Edited task: ${task.title} → ${title}`,
        ),
      );
    }

    cancelTaskEdit();
  };

  const deleteTask = (taskId: string) => {
    const task = statsRef.current?.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }

    Alert.alert("Delete task?", `“${task.title}” will be removed from your list.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          const currentStats = statsRef.current;
          if (!currentStats?.tasks.some((item) => item.id === taskId)) {
            return;
          }

          commitStats(
            addActivity(
              {
                ...currentStats,
                tasks: currentStats.tasks.filter((item) => item.id !== taskId),
              },
              `Deleted task: ${task.title}`,
            ),
          );
        },
      },
    ]);
  };

  if (loading || stats === null) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.centered}>
          {loadError ? (
            <>
              <Text style={styles.errorTitle}>We couldn’t open your tracker</Text>
              <Text style={styles.errorText}>{loadError}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void loadStats()}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Try again</Text>
              </Pressable>
            </>
          ) : (
            <ActivityIndicator color={COLORS.green} size="large" />
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (!stats.trackingEnabled) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <ScrollView
          contentContainerStyle={styles.onboardingContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.brandRow}>
            <View style={styles.brandMark}>
              <Text style={styles.brandMarkText}>T</Text>
            </View>
            <Text style={styles.brandName}>TIME, IN VIEW</Text>
          </View>

          <View style={styles.heroCard}>
            <View style={styles.heroOrb}>
              <View style={styles.heroClock}>
                <View style={styles.clockHand} />
                <View style={styles.clockDot} />
              </View>
            </View>
            <View style={styles.previewLabel}>
              <View style={styles.previewDot} />
              <Text style={styles.previewLabelText}>YOUR APP, YOUR INSIGHT</Text>
            </View>
            <Text style={styles.previewTime}>00:24</Text>
            <View style={styles.previewBars}>
              {[34, 52, 40, 68, 47, 76, 57].map((height, index) => (
                <View
                  key={index}
                  style={[
                    styles.previewBar,
                    { height },
                    index === 5 && styles.previewBarActive,
                  ]}
                />
              ))}
            </View>
          </View>

          <Text style={styles.eyebrow}>A FRESH PERSPECTIVE</Text>
          <Text style={styles.onboardingTitle}>
            Get to know your time here.
          </Text>
          <Text style={styles.onboardingDescription}>
            See how often you open this app, how long you spend in it, and the
            screens you visit.
          </Text>

          <View style={styles.privacyNote}>
            <View style={styles.privacyIcon}>
              <Text style={styles.privacyIconText}>✓</Text>
            </View>
            <View style={styles.privacyCopy}>
              <Text style={styles.privacyTitle}>Just this app</Text>
              <Text style={styles.privacyDescription}>
                Your activity stays on this device. We don’t track other apps
                or inspect what you do outside this one.
              </Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={startTracking}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Start tracking</Text>
            <Text style={styles.buttonArrow}>→</Text>
          </Pressable>
          <Text style={styles.onboardingFootnote}>
            No account needed · You’re in control
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const totalSeconds = stats.totalSeconds + sessionSeconds;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appScreen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.headerEyebrow}>YOUR PRIVATE USAGE LOG</Text>
            <Text style={styles.headerTitle}>
              {tab === "overview"
                ? "Your overview"
                : tab === "tasks"
                  ? "Your tasks"
                  : "Activity"}
            </Text>
          </View>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>ON</Text>
          </View>
        </View>

        {tab === "overview" ? (
          <ScrollView
            contentContainerStyle={styles.dashboardContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.timeCard}>
              <View style={styles.cardTopRow}>
                <Text style={styles.timeCardLabel}>TOTAL TIME IN THIS APP</Text>
                <Text style={styles.timeCardIcon}>◷</Text>
              </View>
              <Text style={styles.totalTime}>{formatDuration(totalSeconds)}</Text>
              <Text style={styles.timeCardCaption}>Since you started tracking</Text>
              <View style={styles.timeCardRule} />
              <Text style={styles.sessionCaption}>
                THIS VISIT{"  ·  "}{formatDuration(visitSeconds + sessionSeconds)}
              </Text>
            </View>

            <View style={styles.statRow}>
              <View style={styles.statCard}>
                <Text style={styles.statIcon}>↗</Text>
                <Text style={styles.statValue}>{stats.launchCount}</Text>
                <Text style={styles.statLabel}>App opens</Text>
              </View>
              <View style={styles.statCard}>
                <Text style={styles.statIcon}>✓</Text>
                <Text style={styles.statValue}>{stats.tasks.length}</Text>
                <Text style={styles.statLabel}>Tasks added</Text>
              </View>
            </View>

            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>Your tasks</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => changeTab("tasks")}
                hitSlop={8}
              >
                <Text style={styles.seeAll}>View tasks</Text>
              </Pressable>
            </View>
            {stats.tasks.length > 0 ? (
              <TaskList
                tasks={stats.tasks.slice(0, 3)}
                onDelete={deleteTask}
                onToggle={toggleTask}
              />
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => changeTab("tasks")}
                style={styles.emptyTasksCard}
              >
                <Text style={styles.emptyTasksTitle}>Add your first task</Text>
                <Text style={styles.emptyTasksText}>
                  Keep a simple log of what you want to get done.
                </Text>
              </Pressable>
            )}

            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>Recent activity</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => changeTab("activity")}
                hitSlop={8}
              >
                <Text style={styles.seeAll}>See all</Text>
              </Pressable>
            </View>
            <ActivityList activities={stats.activities.slice(0, 3)} />
            <Text style={styles.localNote}>
              Tracked privately on this device
            </Text>
          </ScrollView>
        ) : tab === "activity" ? (
          <ScrollView
            contentContainerStyle={styles.dashboardContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.activityIntro}>
              <Text style={styles.activityIntroTitle}>Activity history</Text>
              <Text style={styles.activityIntroText}>
                App usage, screens visited, and task updates are recorded here.
              </Text>
            </View>
            <ActivityList activities={stats.activities} />
            {stats.activities.length === 0 && (
              <Text style={styles.emptyActivity}>
                Your activity will appear here as you use the app.
              </Text>
            )}
            <Text style={styles.localNote}>
              Only activity from this app is recorded
            </Text>
          </ScrollView>
        ) : (
          <ScrollView
            contentContainerStyle={styles.dashboardContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.activityIntro}>
              <Text style={styles.activityIntroTitle}>Your task list</Text>
              <Text style={styles.activityIntroText}>
                Add tasks, check them off, and review each update in Activity.
              </Text>
            </View>
            <View style={styles.taskComposer}>
              <TextInput
                accessibilityLabel="New task"
                onChangeText={setTaskInput}
                onSubmitEditing={addTask}
                placeholder="What do you need to do?"
                placeholderTextColor="#8A948D"
                returnKeyType="done"
                style={styles.taskInput}
                value={taskInput}
              />
              <Pressable
                accessibilityLabel="Add task"
                accessibilityRole="button"
                disabled={!taskInput.trim()}
                onPress={addTask}
                style={[
                  styles.addTaskButton,
                  !taskInput.trim() && styles.addTaskButtonDisabled,
                ]}
              >
                <Text style={styles.addTaskButtonText}>+</Text>
              </Pressable>
            </View>
            <View style={styles.taskSectionHeading}>
              <Text style={styles.taskSectionTitle}>To do</Text>
              <Text style={styles.taskCount}>
                {stats.tasks.filter((item) => item.completedAt === null).length}
              </Text>
            </View>
            {stats.tasks.some((item) => item.completedAt === null) ? (
              <TaskList
                tasks={stats.tasks.filter((item) => item.completedAt === null)}
                onDelete={deleteTask}
                onEdit={beginTaskEdit}
                onMove={moveTask}
                onToggle={toggleTask}
                editDraft={taskEditDraft}
                editingTaskId={editingTaskId}
                onEditDraftChange={setTaskEditDraft}
                onSaveEdit={saveTaskEdit}
                onCancelEdit={cancelTaskEdit}
              />
            ) : (
              <Text style={styles.emptyTasksText}>
                No open tasks. Add one above whenever you’re ready.
              </Text>
            )}
            {stats.tasks.some((item) => item.completedAt !== null) && (
              <>
                <View style={styles.taskSectionHeading}>
                  <Text style={styles.taskSectionTitle}>Completed</Text>
                  <Text style={styles.taskCount}>
                    {stats.tasks.filter((item) => item.completedAt !== null).length}
                  </Text>
                </View>
                <TaskList
                  tasks={stats.tasks.filter((item) => item.completedAt !== null)}
                  onDelete={deleteTask}
                  onEdit={beginTaskEdit}
                  onMove={moveTask}
                  onToggle={toggleTask}
                  editDraft={taskEditDraft}
                  editingTaskId={editingTaskId}
                  onEditDraftChange={setTaskEditDraft}
                  onSaveEdit={saveTaskEdit}
                  onCancelEdit={cancelTaskEdit}
                />
              </>
            )}
            <Text style={styles.localNote}>
              Task history and activity are saved on this device
            </Text>
          </ScrollView>
        )}

        {storageError && (
          <View accessibilityRole="alert" style={styles.storageError}>
            <Text style={styles.storageErrorText}>{storageError}</Text>
          </View>
        )}

        <View style={styles.tabBar}>
          <TabButton
            active={tab === "overview"}
            label="Overview"
            icon="◫"
            onPress={() => changeTab("overview")}
          />
          <TabButton
            active={tab === "tasks"}
            label="Tasks"
            icon="✓"
            onPress={() => changeTab("tasks")}
          />
          <TabButton
            active={tab === "activity"}
            label="Activity"
            icon="☷"
            onPress={() => changeTab("activity")}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const COLORS = {
  background: "#F5F6F2",
  dark: "#1C2922",
  green: "#2C7352",
  greenDark: "#215A40",
  greenLight: "#E5EFE8",
  muted: "#79847C",
  line: "#E7EAE5",
  white: "#FFFFFF",
};

function ActivityList({ activities }: { activities: ActivityItem[] }) {
  return (
    <View style={styles.activityList}>
      {activities.map((item, index) => (
        <View
          key={item.id}
          style={[
            styles.activityRow,
            index === activities.length - 1 && styles.activityRowLast,
          ]}
        >
          <View style={styles.activityMarkerWrap}>
            <View style={styles.activityMarker} />
            {index !== activities.length - 1 && (
              <View style={styles.activityConnector} />
            )}
          </View>
          <View style={styles.activityCopy}>
            <Text style={styles.activityLabel}>{item.label}</Text>
            <Text style={styles.activityTime}>
              {new Date(item.timestamp).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function TaskList({
  editDraft,
  editingTaskId,
  onCancelEdit,
  onDelete,
  onEdit,
  onEditDraftChange,
  onMove,
  onSaveEdit,
  onToggle,
  tasks,
}: {
  editDraft?: string;
  editingTaskId?: string | null;
  onCancelEdit?: () => void;
  onDelete: (taskId: string) => void;
  onEdit?: (taskId: string) => void;
  onEditDraftChange?: (value: string) => void;
  onMove?: (taskId: string, direction: "up" | "down") => void;
  onSaveEdit?: () => void;
  onToggle: (taskId: string) => void;
  tasks: TaskItem[];
}) {
  return (
    <View style={styles.taskList}>
      {tasks.map((task, index) => {
        const completed = task.completedAt !== null;
        const timestamp = task.completedAt ?? task.createdAt;
        const isEditing = editingTaskId === task.id;
        const canEdit =
          onEditDraftChange !== undefined &&
          onSaveEdit !== undefined &&
          onCancelEdit !== undefined;

        return (
          <View
            key={task.id}
            style={[
              styles.taskRow,
              index === tasks.length - 1 && styles.taskRowLast,
            ]}
          >
            {isEditing && canEdit ? (
              <View style={styles.taskEditContainer}>
                <TextInput
                  accessibilityLabel="Edit task"
                  autoFocus
                  onChangeText={onEditDraftChange}
                  onSubmitEditing={onSaveEdit}
                  returnKeyType="done"
                  style={styles.taskEditInput}
                  value={editDraft}
                />
                <Pressable
                  accessibilityLabel="Save task changes"
                  accessibilityRole="button"
                  disabled={!editDraft?.trim()}
                  onPress={onSaveEdit}
                  style={[
                    styles.taskEditButton,
                    !editDraft?.trim() && styles.taskEditButtonDisabled,
                  ]}
                >
                  <Text style={styles.taskEditButtonText}>Save</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Cancel editing task"
                  accessibilityRole="button"
                  onPress={onCancelEdit}
                  style={styles.taskEditCancelButton}
                >
                  <Text style={styles.taskEditCancelText}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Pressable
                  accessibilityLabel={`${completed ? "Reopen" : "Complete"} task: ${task.title}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: completed }}
                  onPress={() => onToggle(task.id)}
                  style={styles.taskMain}
                >
                  <View
                    style={[
                      styles.taskCheckbox,
                      completed && styles.taskCheckboxCompleted,
                    ]}
                  >
                    {completed && <Text style={styles.taskCheckmark}>✓</Text>}
                  </View>
                  <View style={styles.taskCopy}>
                    <Text
                      numberOfLines={2}
                      style={[
                        styles.taskTitle,
                        completed && styles.taskTitleCompleted,
                      ]}
                    >
                      {task.title}
                    </Text>
                    <Text style={styles.taskTimestamp}>
                      {completed ? "Completed" : "Added"}{" "}
                      {new Date(timestamp).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </Text>
                  </View>
                </Pressable>
                <View style={styles.taskActions}>
                  {onMove && (
                    <View style={styles.taskMoveButtons}>
                      <Pressable
                        accessibilityLabel={`Move task up: ${task.title}`}
                        accessibilityRole="button"
                        disabled={index === 0}
                        onPress={() => onMove(task.id, "up")}
                        style={[
                          styles.taskMoveButton,
                          index === 0 && styles.taskMoveButtonDisabled,
                        ]}
                      >
                        <Text style={styles.taskMoveText}>↑</Text>
                      </Pressable>
                      <Pressable
                        accessibilityLabel={`Move task down: ${task.title}`}
                        accessibilityRole="button"
                        disabled={index === tasks.length - 1}
                        onPress={() => onMove(task.id, "down")}
                        style={[
                          styles.taskMoveButton,
                          index === tasks.length - 1 &&
                            styles.taskMoveButtonDisabled,
                        ]}
                      >
                        <Text style={styles.taskMoveText}>↓</Text>
                      </Pressable>
                    </View>
                  )}
                  {onEdit && (
                    <Pressable
                      accessibilityLabel={`Edit task: ${task.title}`}
                      accessibilityRole="button"
                      onPress={() => onEdit(task.id)}
                      style={styles.taskActionButton}
                    >
                      <Text style={styles.taskEditText}>Edit</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityLabel={`Delete task: ${task.title}`}
                    accessibilityRole="button"
                    onPress={() => onDelete(task.id)}
                    style={styles.taskActionButton}
                    hitSlop={6}
                  >
                    <Text style={styles.deleteTaskText}>Delete</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        );
      })}
    </View>
  );
}

function TabButton({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={styles.tabButton}
    >
      <Text style={[styles.tabIcon, active && styles.tabActive]}>{icon}</Text>
      <Text style={[styles.tabLabel, active && styles.tabActive]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  errorTitle: {
    color: COLORS.dark,
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  errorText: {
    color: COLORS.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 22,
    textAlign: "center",
  },
  onboardingContent: {
    flexGrow: 1,
    paddingHorizontal: 25,
    paddingTop: 14,
    paddingBottom: 26,
  },
  brandRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginBottom: 20,
  },
  brandMark: {
    alignItems: "center",
    backgroundColor: COLORS.green,
    borderRadius: 13,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  brandMarkText: {
    color: COLORS.white,
    fontSize: 17,
    fontWeight: "700",
  },
  brandName: {
    color: COLORS.dark,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.8,
  },
  heroCard: {
    alignItems: "center",
    backgroundColor: COLORS.dark,
    borderRadius: 25,
    height: 220,
    justifyContent: "center",
    marginBottom: 27,
    overflow: "hidden",
  },
  heroOrb: {
    alignItems: "center",
    backgroundColor: "#2B3D32",
    borderRadius: 100,
    height: 206,
    justifyContent: "center",
    position: "absolute",
    right: -49,
    top: -60,
    width: 206,
  },
  heroClock: {
    alignItems: "center",
    borderColor: "#6F9A7F",
    borderRadius: 38,
    borderWidth: 2,
    height: 76,
    justifyContent: "center",
    width: 76,
  },
  clockHand: {
    backgroundColor: "#B7D7C2",
    borderRadius: 2,
    height: 23,
    position: "absolute",
    top: 14,
    width: 2,
  },
  clockDot: {
    backgroundColor: "#B7D7C2",
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  previewLabel: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
    marginBottom: 9,
    width: "100%",
    paddingHorizontal: 24,
  },
  previewDot: {
    backgroundColor: "#A8D7B5",
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  previewLabelText: {
    color: "#B7C7BC",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
  previewTime: {
    color: COLORS.white,
    fontSize: 38,
    fontWeight: "600",
    letterSpacing: -1,
    paddingHorizontal: 24,
    textAlign: "left",
    width: "100%",
  },
  previewBars: {
    alignItems: "flex-end",
    bottom: 24,
    flexDirection: "row",
    gap: 6,
    height: 38,
    left: 24,
    position: "absolute",
  },
  previewBar: {
    backgroundColor: "#52675A",
    borderRadius: 3,
    width: 12,
  },
  previewBarActive: {
    backgroundColor: "#95C7A4",
  },
  eyebrow: {
    color: COLORS.green,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.6,
    marginBottom: 9,
  },
  onboardingTitle: {
    color: COLORS.dark,
    fontSize: 29,
    fontWeight: "700",
    letterSpacing: -0.8,
    lineHeight: 35,
    maxWidth: 310,
  },
  onboardingDescription: {
    color: COLORS.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  privacyNote: {
    alignItems: "flex-start",
    backgroundColor: COLORS.greenLight,
    borderRadius: 15,
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
    padding: 15,
  },
  privacyIcon: {
    alignItems: "center",
    backgroundColor: "#D1E4D7",
    borderRadius: 12,
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  privacyIconText: {
    color: COLORS.greenDark,
    fontSize: 15,
    fontWeight: "700",
  },
  privacyCopy: {
    flex: 1,
  },
  privacyTitle: {
    color: COLORS.dark,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 3,
  },
  privacyDescription: {
    color: "#5E6F63",
    fontSize: 12,
    lineHeight: 17,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: COLORS.green,
    borderRadius: 15,
    flexDirection: "row",
    height: 54,
    justifyContent: "center",
    marginTop: 21,
    position: "relative",
  },
  primaryButtonText: {
    color: COLORS.white,
    fontSize: 15,
    fontWeight: "700",
  },
  buttonArrow: {
    color: COLORS.white,
    fontSize: 22,
    position: "absolute",
    right: 19,
  },
  buttonPressed: {
    opacity: 0.86,
  },
  onboardingFootnote: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 12,
    textAlign: "center",
  },
  appScreen: {
    flex: 1,
    paddingTop: 14,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 23,
    paddingBottom: 17,
  },
  headerEyebrow: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
    marginBottom: 5,
  },
  headerTitle: {
    color: COLORS.dark,
    fontSize: 25,
    fontWeight: "700",
    letterSpacing: -0.6,
  },
  liveBadge: {
    alignItems: "center",
    backgroundColor: COLORS.greenLight,
    borderRadius: 20,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  liveDot: {
    backgroundColor: COLORS.green,
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  liveBadgeText: {
    color: COLORS.greenDark,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1,
  },
  dashboardContent: {
    paddingHorizontal: 20,
    paddingBottom: 25,
  },
  timeCard: {
    backgroundColor: COLORS.green,
    borderRadius: 22,
    marginBottom: 13,
    overflow: "hidden",
    padding: 20,
  },
  cardTopRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  timeCardLabel: {
    color: "#D6E8DC",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.3,
  },
  timeCardIcon: {
    color: "#D6E8DC",
    fontSize: 22,
  },
  totalTime: {
    color: COLORS.white,
    fontSize: 43,
    fontWeight: "700",
    letterSpacing: -1.5,
    marginTop: 12,
  },
  timeCardCaption: {
    color: "#D6E8DC",
    fontSize: 12,
    marginTop: 1,
  },
  timeCardRule: {
    backgroundColor: "#63947A",
    height: 1,
    marginTop: 17,
    marginBottom: 12,
  },
  sessionCaption: {
    color: "#E7F1EA",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.8,
  },
  statRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 25,
  },
  statCard: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.line,
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    minHeight: 117,
    padding: 15,
  },
  statIcon: {
    color: COLORS.green,
    fontSize: 20,
    height: 25,
  },
  statValue: {
    color: COLORS.dark,
    fontSize: 26,
    fontWeight: "700",
    marginTop: 4,
  },
  statLabel: {
    color: COLORS.muted,
    fontSize: 11,
    marginTop: 1,
  },
  sectionHeading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  sectionTitle: {
    color: COLORS.dark,
    fontSize: 16,
    fontWeight: "700",
  },
  seeAll: {
    color: COLORS.green,
    fontSize: 12,
    fontWeight: "700",
  },
  emptyTasksCard: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.line,
    borderRadius: 17,
    borderWidth: 1,
    marginBottom: 22,
    padding: 16,
  },
  emptyTasksTitle: {
    color: COLORS.dark,
    fontSize: 13,
    fontWeight: "700",
  },
  emptyTasksText: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  taskComposer: {
    alignItems: "center",
    backgroundColor: COLORS.white,
    borderColor: COLORS.line,
    borderRadius: 15,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: 23,
    padding: 7,
  },
  taskInput: {
    color: COLORS.dark,
    flex: 1,
    fontSize: 13,
    minHeight: 42,
    paddingHorizontal: 10,
  },
  addTaskButton: {
    alignItems: "center",
    backgroundColor: COLORS.green,
    borderRadius: 11,
    height: 42,
    justifyContent: "center",
    width: 44,
  },
  addTaskButtonDisabled: {
    backgroundColor: "#AAB9AF",
  },
  addTaskButtonText: {
    color: COLORS.white,
    fontSize: 25,
    fontWeight: "400",
    lineHeight: 28,
  },
  taskSectionHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  taskSectionTitle: {
    color: COLORS.dark,
    fontSize: 14,
    fontWeight: "700",
  },
  taskCount: {
    backgroundColor: COLORS.greenLight,
    borderRadius: 10,
    color: COLORS.greenDark,
    fontSize: 10,
    fontWeight: "700",
    overflow: "hidden",
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  taskList: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.line,
    borderRadius: 17,
    borderWidth: 1,
    marginBottom: 21,
    paddingHorizontal: 14,
  },
  taskRow: {
    alignItems: "center",
    borderBottomColor: COLORS.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: 66,
  },
  taskRowLast: {
    borderBottomWidth: 0,
  },
  taskMain: {
    alignItems: "center",
    flexDirection: "row",
    flex: 1,
    gap: 12,
    minHeight: 66,
  },
  taskActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2,
  },
  taskMoveButtons: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  taskMoveButton: {
    alignItems: "center",
    backgroundColor: COLORS.greenLight,
    borderRadius: 10,
    height: 36,
    justifyContent: "center",
    width: 34,
  },
  taskMoveButtonDisabled: {
    backgroundColor: "#F1F3F0",
    opacity: 0.55,
  },
  taskMoveText: {
    color: COLORS.greenDark,
    fontSize: 19,
    fontWeight: "700",
  },
  taskActionButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 4,
  },
  taskEditText: {
    color: COLORS.green,
    fontSize: 11,
    fontWeight: "600",
  },
  taskEditContainer: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 64,
  },
  taskEditInput: {
    backgroundColor: COLORS.background,
    borderRadius: 9,
    color: COLORS.dark,
    flex: 1,
    fontSize: 12,
    minHeight: 40,
    paddingHorizontal: 9,
  },
  taskEditButton: {
    alignItems: "center",
    backgroundColor: COLORS.green,
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 38,
    paddingHorizontal: 10,
  },
  taskEditButtonDisabled: {
    backgroundColor: "#AAB9AF",
  },
  taskEditButtonText: {
    color: COLORS.white,
    fontSize: 11,
    fontWeight: "700",
  },
  taskEditCancelButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 38,
    paddingHorizontal: 3,
  },
  taskEditCancelText: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: "600",
  },
  taskCheckbox: {
    alignItems: "center",
    borderColor: "#B7C4BA",
    borderRadius: 8,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  taskCheckboxCompleted: {
    backgroundColor: COLORS.green,
    borderColor: COLORS.green,
  },
  taskCheckmark: {
    color: COLORS.white,
    fontSize: 13,
    fontWeight: "700",
  },
  taskCopy: {
    flex: 1,
    justifyContent: "center",
    minHeight: 66,
    paddingVertical: 10,
  },
  deleteTaskText: {
    color: "#A44B40",
    fontSize: 11,
    fontWeight: "600",
  },
  taskTitle: {
    color: COLORS.dark,
    fontSize: 13,
    fontWeight: "600",
  },
  taskTitleCompleted: {
    color: COLORS.muted,
    textDecorationLine: "line-through",
  },
  taskTimestamp: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 4,
  },
  activityList: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.line,
    borderRadius: 17,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingTop: 4,
  },
  activityRow: {
    flexDirection: "row",
    minHeight: 58,
  },
  activityRowLast: {
    minHeight: 54,
  },
  activityMarkerWrap: {
    alignItems: "center",
    marginRight: 12,
    paddingTop: 17,
    width: 10,
  },
  activityMarker: {
    backgroundColor: COLORS.green,
    borderRadius: 4,
    height: 8,
    width: 8,
    zIndex: 1,
  },
  activityConnector: {
    backgroundColor: "#DCE7DF",
    bottom: 0,
    position: "absolute",
    top: 23,
    width: 1,
  },
  activityCopy: {
    borderBottomColor: COLORS.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: "center",
    paddingVertical: 11,
  },
  activityLabel: {
    color: COLORS.dark,
    fontSize: 12,
    fontWeight: "600",
  },
  activityTime: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 3,
  },
  localNote: {
    color: COLORS.muted,
    fontSize: 10,
    marginTop: 14,
    textAlign: "center",
  },
  activityIntro: {
    marginTop: 1,
    marginBottom: 18,
  },
  activityIntroTitle: {
    color: COLORS.dark,
    fontSize: 17,
    fontWeight: "700",
  },
  activityIntroText: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  emptyActivity: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 19,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  storageError: {
    backgroundColor: "#FFF0EC",
    borderRadius: 10,
    marginHorizontal: 18,
    marginBottom: 6,
    padding: 10,
  },
  storageErrorText: {
    color: "#9D392D",
    fontSize: 11,
    lineHeight: 16,
  },
  tabBar: {
    backgroundColor: COLORS.white,
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: 10,
    paddingBottom: 6,
  },
  tabButton: {
    alignItems: "center",
    flex: 1,
    gap: 3,
    minHeight: 43,
  },
  tabIcon: {
    color: COLORS.muted,
    fontSize: 18,
  },
  tabLabel: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: "600",
  },
  tabActive: {
    color: COLORS.green,
  },
});
