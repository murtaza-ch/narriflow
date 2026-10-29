import type { GuidanceView, PerformanceSummaryView } from "@/lib/publishing-client";

// Summaries and guidance as the performance read returns them, captured once from
// the service computation (summarizePerformance / computePerformanceGuidance) so
// this UI test renders real shapes without importing a backend module. The
// computation itself is covered in packages/services.

export const emptySummary = {
 "measuredVideos": 0,
 "waitingVideos": 0,
 "enough": false,
 "minimumVideos": 5,
 "minimumGroupVideos": 3,
 "totals": {
  "views": 0,
  "likes": 0,
  "comments": 0
 },
 "dimensions": [
  {
   "id": "category",
   "title": "Category",
   "groups": []
  },
  {
   "id": "hook",
   "title": "Hook strength",
   "groups": []
  },
  {
   "id": "duration",
   "title": "Length",
   "groups": []
  },
  {
   "id": "platform",
   "title": "Platform",
   "groups": []
  },
  {
   "id": "hour",
   "title": "Posted hour",
   "groups": []
  }
 ]
} as PerformanceSummaryView;

export const waitingSummary = {
 "measuredVideos": 0,
 "waitingVideos": 2,
 "enough": false,
 "minimumVideos": 5,
 "minimumGroupVideos": 3,
 "totals": {
  "views": 0,
  "likes": 0,
  "comments": 0
 },
 "dimensions": [
  {
   "id": "category",
   "title": "Category",
   "groups": []
  },
  {
   "id": "hook",
   "title": "Hook strength",
   "groups": []
  },
  {
   "id": "duration",
   "title": "Length",
   "groups": []
  },
  {
   "id": "platform",
   "title": "Platform",
   "groups": []
  },
  {
   "id": "hour",
   "title": "Posted hour",
   "groups": []
  }
 ]
} as PerformanceSummaryView;

/** Two measured videos: under the comparison threshold. */
export const littleSummary = {
 "measuredVideos": 2,
 "waitingVideos": 0,
 "enough": false,
 "minimumVideos": 5,
 "minimumGroupVideos": 3,
 "totals": {
  "views": 400,
  "likes": 40,
  "comments": 4
 },
 "dimensions": [
  {
   "id": "category",
   "title": "Category",
   "groups": [
    {
     "key": "insight",
     "label": "Insight",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 400,
      "median": 200
     },
     "likes": {
      "total": 40,
      "median": 20
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "hook",
   "title": "Hook strength",
   "groups": [
    {
     "key": "80-plus",
     "label": "80 and above",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 400,
      "median": 200
     },
     "likes": {
      "total": 40,
      "median": 20
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "duration",
   "title": "Length",
   "groups": [
    {
     "key": "20-40",
     "label": "20 to 40 seconds",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 400,
      "median": 200
     },
     "likes": {
      "total": 40,
      "median": 20
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "platform",
   "title": "Platform",
   "groups": [
    {
     "key": "youtube_shorts",
     "label": "youtube_shorts",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 400,
      "median": 200
     },
     "likes": {
      "total": 40,
      "median": 20
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "hour",
   "title": "Posted hour",
   "groups": [
    {
     "key": "9",
     "label": "9 AM",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 400,
      "median": 200
     },
     "likes": {
      "total": 40,
      "median": 20
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    }
   ]
  }
 ]
} as PerformanceSummaryView;

/** Five measured videos across two platforms, one more still waiting. */
export const realSummary = {
 "measuredVideos": 5,
 "waitingVideos": 1,
 "enough": true,
 "minimumVideos": 5,
 "minimumGroupVideos": 3,
 "totals": {
  "views": 4300,
  "likes": 430,
  "comments": 10
 },
 "dimensions": [
  {
   "id": "category",
   "title": "Category",
   "groups": [
    {
     "key": "humor",
     "label": "Humor",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 3000,
      "median": 1500
     },
     "likes": {
      "total": 300,
      "median": 150
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    },
    {
     "key": "story",
     "label": "Story",
     "videos": 3,
     "enough": true,
     "views": {
      "total": 1300,
      "median": 300
     },
     "likes": {
      "total": 130,
      "median": 30
     },
     "comments": {
      "total": 6,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "hook",
   "title": "Hook strength",
   "groups": [
    {
     "key": "below-60",
     "label": "Below 60",
     "videos": 1,
     "enough": false,
     "views": {
      "total": 900,
      "median": 900
     },
     "likes": {
      "total": 90,
      "median": 90
     },
     "comments": {
      "total": 2,
      "median": 2
     }
    },
    {
     "key": "80-plus",
     "label": "80 and above",
     "videos": 4,
     "enough": true,
     "views": {
      "total": 3400,
      "median": 650
     },
     "likes": {
      "total": 340,
      "median": 65
     },
     "comments": {
      "total": 8,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "duration",
   "title": "Length",
   "groups": [
    {
     "key": "20-40",
     "label": "20 to 40 seconds",
     "videos": 3,
     "enough": true,
     "views": {
      "total": 1300,
      "median": 300
     },
     "likes": {
      "total": 130,
      "median": 30
     },
     "comments": {
      "total": 6,
      "median": 2
     }
    },
    {
     "key": "40-60",
     "label": "40 to 60 seconds",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 3000,
      "median": 1500
     },
     "likes": {
      "total": 300,
      "median": 150
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "platform",
   "title": "Platform",
   "groups": [
    {
     "key": "tiktok",
     "label": "tiktok",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 3000,
      "median": 1500
     },
     "likes": {
      "total": 300,
      "median": 150
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    },
    {
     "key": "youtube_shorts",
     "label": "youtube_shorts",
     "videos": 3,
     "enough": true,
     "views": {
      "total": 1300,
      "median": 300
     },
     "likes": {
      "total": 130,
      "median": 30
     },
     "comments": {
      "total": 6,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "hour",
   "title": "Posted hour",
   "groups": [
    {
     "key": "8",
     "label": "8 AM",
     "videos": 2,
     "enough": false,
     "views": {
      "total": 400,
      "median": 200
     },
     "likes": {
      "total": 40,
      "median": 20
     },
     "comments": {
      "total": 4,
      "median": 2
     }
    },
    {
     "key": "18",
     "label": "6 PM",
     "videos": 3,
     "enough": true,
     "views": {
      "total": 3900,
      "median": 1000
     },
     "likes": {
      "total": 390,
      "median": 100
     },
     "comments": {
      "total": 6,
      "median": 2
     }
    }
   ]
  }
 ]
} as PerformanceSummaryView;

/** Forty measured videos: fifteen Story, fifteen Insight and ten Humor. */
export const manySummary = {
 "measuredVideos": 40,
 "waitingVideos": 0,
 "enough": true,
 "minimumVideos": 5,
 "minimumGroupVideos": 3,
 "totals": {
  "views": 19000,
  "likes": 1900,
  "comments": 80
 },
 "dimensions": [
  {
   "id": "category",
   "title": "Category",
   "groups": [
    {
     "key": "story",
     "label": "Story",
     "videos": 15,
     "enough": true,
     "views": {
      "total": 15000,
      "median": 1000
     },
     "likes": {
      "total": 1500,
      "median": 100
     },
     "comments": {
      "total": 30,
      "median": 2
     }
    },
    {
     "key": "insight",
     "label": "Insight",
     "videos": 15,
     "enough": true,
     "views": {
      "total": 3000,
      "median": 200
     },
     "likes": {
      "total": 300,
      "median": 20
     },
     "comments": {
      "total": 30,
      "median": 2
     }
    },
    {
     "key": "humor",
     "label": "Humor",
     "videos": 10,
     "enough": true,
     "views": {
      "total": 1000,
      "median": 100
     },
     "likes": {
      "total": 100,
      "median": 10
     },
     "comments": {
      "total": 20,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "hook",
   "title": "Hook strength",
   "groups": [
    {
     "key": "80-plus",
     "label": "80 and above",
     "videos": 40,
     "enough": true,
     "views": {
      "total": 19000,
      "median": 200
     },
     "likes": {
      "total": 1900,
      "median": 20
     },
     "comments": {
      "total": 80,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "duration",
   "title": "Length",
   "groups": [
    {
     "key": "20-40",
     "label": "20 to 40 seconds",
     "videos": 40,
     "enough": true,
     "views": {
      "total": 19000,
      "median": 200
     },
     "likes": {
      "total": 1900,
      "median": 20
     },
     "comments": {
      "total": 80,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "platform",
   "title": "Platform",
   "groups": [
    {
     "key": "youtube_shorts",
     "label": "youtube_shorts",
     "videos": 40,
     "enough": true,
     "views": {
      "total": 19000,
      "median": 200
     },
     "likes": {
      "total": 1900,
      "median": 20
     },
     "comments": {
      "total": 80,
      "median": 2
     }
    }
   ]
  },
  {
   "id": "hour",
   "title": "Posted hour",
   "groups": [
    {
     "key": "9",
     "label": "9 AM",
     "videos": 40,
     "enough": true,
     "views": {
      "total": 19000,
      "median": 200
     },
     "likes": {
      "total": 1900,
      "median": 20
     },
     "comments": {
      "total": 80,
      "median": 2
     }
    }
   ]
  }
 ]
} as PerformanceSummaryView;

export const manyGuidance: Pick<GuidanceView, "totalPosts" | "platforms" | "groups"> = {
 totalPosts: 40,
 platforms: [
 {
  "platform": "youtube_shorts",
  "posts": 40,
  "medianViews": 200
 }
],
 groups: [
 {
  "dimension": "category",
  "key": "story",
  "posts": 15,
  "lift": 2.71,
  "label": "Story"
 },
 {
  "dimension": "category",
  "key": "insight",
  "posts": 15,
  "lift": 1,
  "label": "Insight"
 },
 {
  "dimension": "duration",
  "key": "20-40",
  "posts": 40,
  "lift": 1,
  "label": "20 to 40 seconds"
 },
 {
  "dimension": "category",
  "key": "humor",
  "posts": 10,
  "lift": 0.83,
  "label": "Humor"
 }
],
};
