import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  Candidate,
  CandidateFilter,
  CandidateStats,
  CandidateStatus,
} from "../../electron/shared";

const EMPTY_STATS: CandidateStats = {
  total: 0,
  待沟通: 0,
  已沟通: 0,
  已发offer: 0,
  已淘汰: 0,
};

export const useTalentsStore = defineStore("talents", () => {
  const list = ref<Candidate[]>([]);
  const stats = ref<CandidateStats>({ ...EMPTY_STATS });
  const loading = ref(false);

  async function refresh(filter?: CandidateFilter) {
    loading.value = true;
    try {
      const [items, s] = await Promise.all([
        window.piAgent.talents.list(filter),
        window.piAgent.talents.stats(),
      ]);
      list.value = items;
      stats.value = s;
    } finally {
      loading.value = false;
    }
  }

  async function get(id: string) {
    return window.piAgent.talents.get(id);
  }

  async function updateStatus(id: string, status: CandidateStatus) {
    await window.piAgent.talents.updateStatus(id, status);
    await refresh();
  }

  async function remove(id: string) {
    await window.piAgent.talents.delete(id);
    await refresh();
  }

  return { list, stats, loading, refresh, get, updateStatus, remove };
});
