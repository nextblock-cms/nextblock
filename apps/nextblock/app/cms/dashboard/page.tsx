import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@nextblock-cms/ui"
import { Calendar, FileText, PenTool, Users, Eye, TrendingUp, DollarSign, Receipt, ShoppingCart } from "lucide-react"
import { getDashboardStats } from "./actions"
import { MetricCard, SalesLedger, PremiumCTA } from "./components/DashboardComponents"
import DashboardOnboarding from "./components/DashboardOnboarding"
import { getOnboardingStatus } from "../../../lib/onboarding/status"
import { setOnboardingDismissed } from "../../../lib/onboarding/actions"
import { formatPrice } from "@nextblock-cms/utils"

export default async function CmsDashboardPage() {
  const stats = await getDashboardStats();
  const onboarding = await getOnboardingStatus({
    isCortexAiActive: stats.isAiActive,
    isEcommerceActive: stats.isEcommerceActive,
  });

  const isEcommerce = stats.isEcommerceActive;

  return (
    <div className="w-full space-y-8">
      <DashboardOnboarding status={onboarding} dismissAction={setOnboardingDismissed} />

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard Overview</h2>
          <p className="text-muted-foreground">
            {isEcommerce 
              ? "Monitoring your store performance and business metrics." 
              : "Welcome to NextBlock™ CMS. Manage your content and site activity."}
          </p>
        </div>
        {isEcommerce && (
          <div className="flex items-center gap-2 px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-full text-xs font-medium dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800">
            <ShoppingCart className="h-3 w-3" />
            Commerce Pro Active
          </div>
        )}
      </div>

      {/* VIEW 1: Standard Dashboard (or secondary row for ecommerce) */}
      {!isEcommerce ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard 
            title="Total Pages" 
            value={stats.totalPages} 
            description="Published pages" 
            icon={FileText} 
          />
          <MetricCard 
            title="Blog Posts" 
            value={stats.totalPosts} 
            description="Total articles" 
            icon={PenTool} 
          />
          <MetricCard 
            title="Registered Users" 
            value={stats.totalUsers} 
            description="Active profiles" 
            icon={Users} 
          />
          <MetricCard 
            title="Page Views" 
            value="--" 
            description="Analytics coming soon" 
            icon={Eye} 
          />
        </div>
      ) : (
        /* VIEW 2: E-commerce Dashboard Primary Metrics */
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCard 
            title="Monthly Revenue" 
            value={formatPrice(stats.ecommerce?.monthlyRevenue || 0)} 
            description="Gross revenue this month" 
            icon={DollarSign}
            className="bg-primary/5 border-primary/20"
            trend={stats.ecommerce?.revenueTrend}
          />
          <MetricCard 
            title="Tax Liability" 
            value={formatPrice(stats.ecommerce?.taxLiability || 0)} 
            description="Auto-tax collection" 
            icon={Receipt} 
          />
          <Card className="bg-gradient-to-br from-indigo-50 to-white dark:from-indigo-950/20 dark:to-slate-900 border-indigo-100 dark:border-indigo-900/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-indigo-600" />
                Sales Velocity
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">Stable</div>
              <p className="text-xs text-muted-foreground mt-1">Based on recent 10 sales</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Section */}
        <div className="lg:col-span-2 space-y-6">
          {isEcommerce ? (
             <SalesLedger sales={stats.ecommerce?.recentSales || []} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>Latest content updates across your site</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {stats.recentContent.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No recent content found.</p>
                  ) : (
                    stats.recentContent.map((item, index) => (
                      <div key={index} className="flex items-start gap-4 pb-4 border-b last:border-0 last:pb-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${item.type === "page" ? "bg-blue-100 text-blue-600" : "bg-amber-100 text-amber-600"} dark:bg-opacity-20`}>
                          {item.type === "page" ? <FileText className="h-4 w-4" /> : <PenTool className="h-4 w-4" />}
                        </div>
                        <div className="flex-1">
                          <h4 className="text-sm font-medium">{item.title}</h4>
                          <div className="flex items-center gap-2 mt-1">
                            <p className="text-xs text-muted-foreground">{item.author}</p>
                            <span className="text-xs text-muted-foreground">•</span>
                            <p className="text-xs text-muted-foreground">{item.date}</p>
                          </div>
                        </div>
                        <Badge variant="outline" className={item.status === 'published' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-700'}>
                          {item.status}
                        </Badge>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Secondary Stats Row for Ecommerce */}
          {isEcommerce && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <MetricCard 
                title="Pages" 
                value={stats.totalPages} 
                icon={FileText} 
              />
              <MetricCard 
                title="Posts" 
                value={stats.totalPosts} 
                icon={PenTool} 
              />
              <MetricCard 
                title="Users" 
                value={stats.totalUsers} 
                icon={Users} 
              />
            </div>
          )}
        </div>

        {/* Sidebar Section */}
        <div className="space-y-6">
          <PremiumCTA
            hasCommerce={stats.isEcommerceActive}
            hasAi={stats.isAiActive}
            isAdmin={onboarding.viewerIsAdmin}
          />

          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Upcoming Schedule
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {stats.scheduledContent.length === 0 ? (
                   <p className="text-xs text-muted-foreground py-4 text-center">No content scheduled.</p>
                ) : (
                  stats.scheduledContent.map((item, index) => (
                    <div key={index} className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-medium truncate">{item.title}</h4>
                        <p className="text-[10px] text-muted-foreground">{item.date}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function Badge({ children, variant = 'outline', className }: { children: React.ReactNode, variant?: string, className?: string }) {
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${className}`}>
      {children}
    </span>
  )
}
