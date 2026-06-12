// Single source of truth for site content.
// When the admin CMS lands, this shape moves into Firestore (site/profile,
// experience/*) — keep it serializable and flat for that migration.

export const profile = {
  name: "Nutthapong Kanna",
  role: "Cloud Engineer",
  company: "Big Data Institute (BDI)",
  headline: "Cloud Engineer — multi-cloud infrastructure & data platforms",
  tagline:
    "I build and operate cloud infrastructure across AWS and Google Cloud at Big Data Institute (BDI), Thailand.",
  about: [
    "I'm a cloud engineer at Big Data Institute (BDI) in Thailand, working on the infrastructure behind data platform projects — from Kubernetes clusters to data lakes and the networking that ties multi-cloud environments together.",
    "I care about infrastructure as code, automation, and systems that stay simple enough to operate well.",
  ],
  email: "nutthapong.ka1998@gmail.com",
  location: "Bangkok, Thailand",
  github: "https://github.com/nutthapong224",
  linkedin: "https://www.linkedin.com/in/nutthapong-kanna-63047a306",
} as const;

export const skillGroups = [
  { label: "Cloud Platforms", items: ["AWS", "Google Cloud"] },
  {
    label: "Data Platform",
    items: ["Dataproc", "AWS Glue","Airflow", "Athena", "S3", "MinIO"],
  },
  { label: "Containers & Orchestration", items: ["Kubernetes", "EKS", "GKE"] },
  {
    label: "Infrastructure & Networking",
    items: ["Terraform", "NGINX", "Docker", "Cloudflare", "Transit Gateway", "OpenVPN", "IAM"],
  },
  { label: "Git & Version Control", items: ["Git", "GitHub", "GitLab"] },
  { label: "CI/CD", items: ["GitLab CI/CD", "GitHub Actions"] },
  {
    label: "Web Development",
    items: ["React","Nextjs", "Node.js","Flask","Fastapi", "MariaDB"],
  },
  { label: "Languages & OS", items: ["Python", "Linux", "Ubuntu"] },
  { label: "AI Services", items: ["Amazon Bedrock"] },
] as const;

export const experience = [
  {
    role: "Cloud Engineer",
    company: "Big Data Institute (BDI)",
    period: "Oct 2025 – Present",
    summary: "Cloud infrastructure for national data platform projects.",
    points: [
      "Operate cloud infrastructure across AWS and Google Cloud",
      "Provision infrastructure as code with Terraform",
      "Run containerized workloads on EKS and GKE",
      "Work with data services: Dataproc, AWS Glue, Athena, S3, MinIO",
      "Manage networking and access: Transit Gateway, OpenVPN, IAM",
    ],
  },
  {
    role: "System Engineer (Internship)",
    company: "Apex Capable Tech",
    period: "2025 · 4 months",
    summary:
      "System engineering internship — CI/CD, Kubernetes, and full-stack web work.",
    points: [
      "Built and maintained CI/CD pipelines with GitLab CI/CD",
      "Deployed and operated workloads on Kubernetes",
      "Developed a website with React and Node.js backed by MariaDB",
    ],
  },
] as const;
